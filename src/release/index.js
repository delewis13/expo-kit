// `@delewis13/expo-kit/release`: lets an app's own tests check what `expo-kit release` will read,
// e.g. that the current version's store notes exist and fit the store limits.

const { CONVENTIONS } = require('./conventions');
const { loadReleaseNotes } = require('./project');

module.exports = { CONVENTIONS, loadReleaseNotes };
