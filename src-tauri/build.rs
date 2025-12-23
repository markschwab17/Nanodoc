fn main() {
    // Compile Objective-C code for macOS Apple Events handling
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=Foundation");

        // Compile the Objective-C file
        cc::Build::new()
            .file("src/app_delegate.m")
            .flag("-fobjc-arc") // Enable Automatic Reference Counting
            .compile("app_delegate");
    }

    tauri_build::build()
}























