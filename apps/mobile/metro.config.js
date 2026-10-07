const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Allow Metro to bundle .onnx model files and .wasm binaries (needed for
// @ricky0123/vad-web and onnxruntime-web assets in apps/mobile/assets/vad/).
config.resolver.assetExts = [
  ...(config.resolver.assetExts || []),
  'onnx',
  'wasm',
];

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// packages/api pins React 19 for Next.js; apps/mobile needs React 18.3.1 for
// Expo/RN. Without this, Metro's hierarchical lookup can hoist a workspace
// dependency (e.g. one with a loose `react` peer range) to the root
// node_modules and resolve it against the wrong React copy.
config.resolver.disableHierarchicalLookup = true;

// markdown-it requires the deprecated Node built-in 'punycode'.
// Metro can't resolve Node builtins, so we point it at the
// userland npm package instead.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  punycode: require.resolve('punycode'),
  // react-native-reanimated bundles its own semver but Metro can't find it
  // when disableHierarchicalLookup is true (needed for the React version pin).
  semver: path.resolve(
    workspaceRoot,
    'node_modules/react-native-reanimated/node_modules/semver',
  ),
};

module.exports = config;
