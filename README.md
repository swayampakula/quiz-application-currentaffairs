# PDF Quiz Application (Hindi + English)

This React app loads questions from a PDF, where the **last page is the answer key**.

## Features

- Load reference PDF: `1763452042.pdf`
- Upload any compatible PDF manually
- Language preference toggle: English / हिंदी
- Quiz navigation (Previous / Next)
- Submit and score calculation

## Reference PDF setup

The app tries to load `public/1763452042.pdf`.

Copy the file from your Downloads folder:

```bash
cp ~/Downloads/1763452042.pdf ./public/1763452042.pdf
```

If not copied, you can still use **Upload PDF** in the UI.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## GitHub Pages Deployment

This project is configured for GitHub Pages.

- Vite `base` is set to relative (`./`) in [vite.config.js](vite.config.js)
- Deploy scripts are available in [package.json](package.json):
	- `npm run predeploy`
	- `npm run deploy`
- GitHub Actions workflow is added at [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)

### Option 1: Automatic deploy from `main`

1. Push to `main`.
2. In GitHub repo settings, open **Pages**.
3. Set source to **GitHub Actions**.
4. The workflow deploys `dist/` automatically.

### Option 2: Manual deploy from local

```bash
npm run deploy
```

This publishes `dist/` to the `gh-pages` branch.
