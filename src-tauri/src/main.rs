#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some(origin) if origin.starts_with("chrome-extension://") => {
            if abw_lib::po_bridge::serve(origin).is_err() {
                std::process::exit(1);
            }
            return;
        }
        #[cfg(windows)]
        Some("--register-po-host") => {
            if args
                .next()
                .is_none_or(|id| abw_lib::po_bridge::register(&id).is_err())
            {
                std::process::exit(1);
            }
            return;
        }
        _ => {}
    }
    abw_lib::run();
}
