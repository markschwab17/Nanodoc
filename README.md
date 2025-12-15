# Nanodoc

A hybrid PDF Editor that works as both a Web App and a downloadable Desktop App (Tauri).

## Technical Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Rust (Tauri)
- **UI Framework**: shadcn/ui (Tailwind CSS + Radix UI)
- **State Management**: Zustand
- **PDF Engine**: mupdf-js (WASM) - *to be implemented*
- **Icons**: lucide-react

## Project Structure

```
src/
├── core/              # Core abstractions
│   └── fs/           # File system abstraction layer
├── features/         # Feature modules (viewer, thumbnails, toolbar)
├── shared/           # Shared components, hooks, utils
│   ├── components/
│   ├── hooks/
│   └── utils/
├── components/
│   └── ui/           # shadcn/ui components
├── lib/
│   └── utils.ts      # Utility functions (cn helper)
└── App.tsx
```

## Development

### Initial Setup

If you need to regenerate placeholder icons:
```bash
./scripts/create-icons.sh
```

### Web Development
```bash
npm run dev
```

### Tauri Development
```bash
npm run tauri dev
```

### Build
```bash
# Web build
npm run build

# Tauri build
npm run tauri build
```

## Deployment

### Web App
The web version is hosted at: **https://Nanodoc.app**

To deploy:
1. Run `npm run build` to create the production build in `dist/`
2. Deploy the contents of the `dist/` directory to your hosting provider
3. Ensure the server is configured to serve `index.html` for all routes (SPA routing)

## Architecture

### File System Abstraction

The app includes a file system abstraction layer that automatically detects the environment (Browser vs Tauri) and uses the appropriate implementation:

- **Browser**: Uses HTML Input API and File API
- **Tauri**: Uses native file system plugins

The `useFileSystem()` hook provides a unified interface for file operations regardless of the environment.

### Code Organization

- **250 line limit**: No single file exceeds 250 lines of code
- **Feature-based structure**: Features are organized in the `src/features` directory
- **Shared utilities**: Common components and hooks in `src/shared`
- **Core abstractions**: Environment-agnostic interfaces in `src/core`

## License

MIT
