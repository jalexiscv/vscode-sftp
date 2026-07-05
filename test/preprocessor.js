const tsc = require('typescript');
const tsConfig = require('../tsconfig.json');

module.exports = {
  // jest >= 28 requires transformers to return an object with a `code` property
  process(src, path) {
    if (path.endsWith('.ts')) {
      return { code: tsc.transpile(src, tsConfig.compilerOptions, path, []) };
    }
    return { code: src };
  },
};
