/** @throws Error if an error without the code ENOENT was caught */
module.exports = function isDirSync(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false;
    } else {
      throw e;
    }
  }
}
