const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

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

module.exports = config;
