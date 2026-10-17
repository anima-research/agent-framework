- The npm package no longer ships the compiled test suite or the
  compiler's build record: `files` packs `dist/src` and `src`, so
  `dist/test`, about half the published files, and
  `dist/tsconfig.tsbuildinfo` stay out, and the package's contents no
  longer depend on whether the tests ran before packing. The redundant
  `discord.js` entry in `devDependencies` is gone (it is a dependency).
