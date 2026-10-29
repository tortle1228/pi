//! Sets the linker flags a Node-API addon needs, for example `-undefined dynamic_lookup` on macOS.

fn main() {
    napi_build::setup();
}
