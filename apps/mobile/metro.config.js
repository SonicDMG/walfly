const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// markdown-it requires the deprecated Node built-in 'punycode'.
// Metro can't resolve Node builtins, so we point it at the
// userland npm package instead.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  punycode: require.resolve('punycode'),
};

module.exports = config;
