//! The search itself: list files in ripgrep's order, search them in parallel batches, and stop at the hit limit.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::overrides::OverrideBuilder;
use ignore::{WalkBuilder, WalkState};
use rayon::prelude::*;

use crate::{GrepHit, GrepMode, GrepRequest};

/// Files searched in parallel before the hit limit is checked again.
const BATCH_SIZE: usize = 256;

/// A file to search. ripgrep treats a file named on the command line differently from one found by walking.
struct Candidate {
    path: PathBuf,
    explicit: bool,
}

/// Runs the whole search; returns at most `max_hits` hits, or an empty list once cancelled.
pub fn run(request: &GrepRequest, cancelled: &AtomicBool) -> Result<Vec<GrepHit>, String> {
    let matcher = build_matcher(request)?;
    let candidates = list_candidates(request, cancelled)?;
    let max_hits = request.max_hits as usize;
    let mut hits = Vec::new();
    for batch in candidates.chunks(BATCH_SIZE) {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(Vec::new());
        }
        let results: Vec<Vec<GrepHit>> = batch
            .par_iter()
            .map(|candidate| search_file(&matcher, request, candidate, max_hits, cancelled))
            .collect();
        for hit in results.into_iter().flatten() {
            if hits.len() == max_hits {
                return Ok(hits);
            }
            hits.push(hit);
        }
    }
    Ok(hits)
}

fn build_matcher(request: &GrepRequest) -> Result<RegexMatcher, String> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .case_insensitive(request.ignore_case)
        .fixed_strings(request.literal)
        .multi_line(true);
    // Like ripgrep: without multiline, a match can never contain a line end.
    if !request.multiline {
        builder.line_terminator(Some(b'\n'));
    }
    builder
        .build(&request.pattern)
        .map_err(|error| error.to_string())
}

/// Lists files in `rg --sort path` order: roots as given, each directory's files ordered component-wise by path.
fn list_candidates(
    request: &GrepRequest,
    cancelled: &AtomicBool,
) -> Result<Vec<Candidate>, String> {
    let mut candidates = Vec::new();
    for root in &request.paths {
        let root = Path::new(root);
        // A file named directly is searched as is: ripgrep applies neither globs nor ignore files to it.
        if root.is_file() {
            candidates.push(Candidate {
                path: root.to_path_buf(),
                explicit: true,
            });
            continue;
        }
        let mut overrides = OverrideBuilder::new(root);
        for glob in &request.globs {
            overrides.add(glob).map_err(|error| error.to_string())?;
        }
        let overrides = overrides.build().map_err(|error| error.to_string())?;
        let files = Mutex::new(Vec::new());
        WalkBuilder::new(root)
            .hidden(false)
            .add_custom_ignore_filename(".rgignore")
            .overrides(overrides)
            .build_parallel()
            .run(|| {
                let files = &files;
                Box::new(move |entry| {
                    if cancelled.load(Ordering::Relaxed) {
                        return WalkState::Quit;
                    }
                    if let Ok(entry) = entry
                        && entry.file_type().is_some_and(|kind| kind.is_file())
                    {
                        files
                            .lock()
                            .expect("walk results lock")
                            .push(entry.into_path());
                    }
                    WalkState::Continue
                })
            });
        let mut files = files.into_inner().expect("walk results lock");
        // PathBuf orders by components, which is the order of ripgrep's sorted depth-first walk.
        files.sort();
        candidates.extend(files.into_iter().map(|path| Candidate {
            path,
            explicit: false,
        }));
    }
    Ok(candidates)
}

fn search_file(
    matcher: &RegexMatcher,
    request: &GrepRequest,
    candidate: &Candidate,
    max_hits: usize,
    cancelled: &AtomicBool,
) -> Vec<GrepHit> {
    if cancelled.load(Ordering::Relaxed) {
        return Vec::new();
    }
    // Like ripgrep: a walked binary file is skipped at its first NUL byte; a named one is searched with NULs read
    // as line ends.
    let binary = if candidate.explicit {
        BinaryDetection::convert(b'\x00')
    } else {
        BinaryDetection::quit(b'\x00')
    };
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .multi_line(request.multiline)
        .binary_detection(binary)
        .build();
    let file_path = candidate.path.to_string_lossy().into_owned();
    let mut sink = HitSink {
        matcher,
        mode: &request.mode,
        file_path: &file_path,
        hits: Vec::new(),
        count: 0,
        max_hits,
    };
    // An unreadable file yields no hits; ripgrep reports it on stderr and goes on.
    let _ = searcher.search_path(matcher, &candidate.path, &mut sink);
    let HitSink { hits, count, .. } = sink;
    match request.mode {
        GrepMode::Content => hits,
        _ if count == 0 => Vec::new(),
        GrepMode::Files => vec![file_hit("file", file_path, None)],
        GrepMode::Count => vec![file_hit("count", file_path, Some(count))],
    }
}

fn file_hit(kind: &str, file_path: String, count: Option<u32>) -> GrepHit {
    GrepHit {
        r#type: kind.to_string(),
        file_path,
        line_number: None,
        line_text: None,
        count,
    }
}

/// Collects one file's results: match hits in content mode, a match count otherwise.
struct HitSink<'a> {
    matcher: &'a RegexMatcher,
    mode: &'a GrepMode,
    file_path: &'a str,
    hits: Vec<GrepHit>,
    count: u32,
    max_hits: usize,
}

impl Sink for HitSink<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        found: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        match self.mode {
            // One match is enough to list the file.
            GrepMode::Files => {
                self.count = 1;
                Ok(false)
            }
            // ripgrep counts every match, not every matching line.
            GrepMode::Count => {
                let _ = self.matcher.find_iter(found.bytes(), |_| {
                    self.count += 1;
                    true
                });
                Ok(true)
            }
            GrepMode::Content => {
                self.hits.push(GrepHit {
                    r#type: "match".to_string(),
                    file_path: self.file_path.to_string(),
                    line_number: found.line_number().map(|line| line as u32),
                    // Non-UTF-8 text stays unset, as in ripgrep's JSON; the tool then reads the file itself.
                    line_text: std::str::from_utf8(found.bytes()).ok().map(str::to_string),
                    count: None,
                });
                // No file needs more hits than the whole search returns.
                Ok(self.hits.len() < self.max_hits)
            }
        }
    }
}
