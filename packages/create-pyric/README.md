# create-pyric

Scaffold a Pyric app. Used by:

```bash
npm create pyric@latest [dir]
```

Default template is **web**: a Vite app wired to `@pyric/cli/vite`. Then:

```bash
cd <dir>   # if you passed a directory
npm install
npm run dev
```

Use `--template chat` for the full React/Firebase/AI reference app. The default
remains the smaller Vite starter.

Flags: `--template web|node|static|chat`, `--name`, `--force`, `--json`.

The directory is the optional positional argument; omit it to scaffold in the current working directory. `--name` only sets the package name.
