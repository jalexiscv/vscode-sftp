const { fs } = require('memfs');

// memfs ignores `autoClose: false` and closes the fd asynchronously after
// 'finish', which breaks callers that keep ownership of the fd (futimes/close
// on it afterwards, like TransferTask does). Neutralize its internal close so
// the mock behaves like the real node fs.
const realCreateWriteStream = fs.createWriteStream.bind(fs);
fs.createWriteStream = (path, options) => {
  const stream = realCreateWriteStream(path, options);
  if (options && options.fd !== undefined && options.autoClose === false) {
    stream.close = cb => {
      if (cb) cb(null);
    };
  }
  return stream;
};

fs.__mock__ = true;
module.exports = fs;
