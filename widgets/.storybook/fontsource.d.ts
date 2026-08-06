// @fontsource packages ship CSS (via their "main"/"exports" fields), not type
// declarations, so a bare side-effect import like `import '@fontsource/geist-sans'`
// has nothing for tsc to resolve. These ambient declarations tell TypeScript the
// modules exist without asserting any shape, matching fontsource's documented
// usage (see https://fontsource.org/docs/getting-started/install).
declare module '@fontsource/geist-sans';
declare module '@fontsource/geist-mono';
