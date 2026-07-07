const tsc = require('typescript');
const path = require('path');

// tsconfig.json es JSONC (admite comentarios), así que no puede leerse con
// require(): hay que usar el lector de TypeScript
const tsConfig = tsc.readConfigFile(
  path.join(__dirname, '..', 'tsconfig.json'),
  tsc.sys.readFile
).config;

module.exports = {
  // jest >= 28 requires transformers to return an object with a `code` property
  process(src, path) {
    if (path.endsWith('.ts')) {
      return { code: tsc.transpile(src, tsConfig.compilerOptions, path, []) };
    }
    return { code: src };
  },
};
