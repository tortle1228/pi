//! Node-API surface of the in-process grep engine: `search()` runs on the libuv thread pool and resolves to hits.
//!
//! The engine follows the TypeScript `GrepEngine` contract in `src/core/tools/grep-engine.ts`: it searches like
//! `rg --hidden --sort path` and returns at most `maxHits` hits, ordered by path, then by line.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

mod search;

/// Request fields mirror `GrepEngineRequest`.
#[napi(object)]
pub struct GrepRequest {
    pub pattern: String,
    pub paths: Vec<String>,
    pub globs: Vec<String>,
    pub ignore_case: bool,
    pub literal: bool,
    pub multiline: bool,
    pub mode: GrepMode,
    pub max_hits: u32,
}

#[napi(string_enum = "lowercase")]
#[derive(PartialEq, Eq)]
pub enum GrepMode {
    Content,
    Files,
    Count,
}

/// One hit; `type` is `match`, `file`, or `count`, and only that kind's fields are set.
#[napi(object)]
pub struct GrepHit {
    pub r#type: String,
    pub file_path: String,
    pub line_number: Option<u32>,
    pub line_text: Option<String>,
    pub count: Option<u32>,
}

/// Stops a running search. JavaScript cancels it on abort; the search checks it between files.
#[napi]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl CancelToken {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        CancelToken {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

pub struct SearchTask {
    request: GrepRequest,
    cancelled: Arc<AtomicBool>,
}

impl Task for SearchTask {
    type Output = Vec<GrepHit>;
    type JsValue = Vec<GrepHit>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        search::run(&self.request, &self.cancelled).map_err(napi::Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Searches on the thread pool. Rejects with the message of an invalid pattern or glob.
#[napi]
pub fn search(request: GrepRequest, token: &CancelToken) -> AsyncTask<SearchTask> {
    AsyncTask::new(SearchTask {
        request,
        cancelled: token.cancelled.clone(),
    })
}
