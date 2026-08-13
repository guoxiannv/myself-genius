const { getDefaultConfig } = require('expo/metro-config');
const { createHarmonyMetroConfig } = require('@react-native-oh/react-native-harmony/metro.config');
const path = require('path');

let expoMetroRequire;
try {
  expoMetroRequire = require.resolve('@expo/cli/build/metro-require/require');
} catch (_error) {
  expoMetroRequire = require.resolve(path.join(
    path.dirname(require.resolve('expo/package.json')),
    'node_modules/@expo/cli/build/metro-require/require'
  ));
}
require('@expo/metro/metro-config/defaults/defaults').moduleSystem = expoMetroRequire;
require('metro-config/private/defaults/defaults').moduleSystem = expoMetroRequire;
require(path.join(path.dirname(require.resolve('metro-config')), 'defaults/defaults')).moduleSystem = expoMetroRequire;

const expoConfig = getDefaultConfig(__dirname);
const harmonyConfig = createHarmonyMetroConfig({
  reactNativeHarmonyPackageName: '@react-native-oh/react-native-harmony',
});
const config = {
  ...expoConfig,
  transformer: { ...expoConfig.transformer, ...harmonyConfig.transformer, unstable_allowRequireContext: true },
  serializer: { ...expoConfig.serializer, ...harmonyConfig.serializer },
  resolver: { ...expoConfig.resolver, ...harmonyConfig.resolver },
};
config.projectRoot = __dirname;
config.watchFolders = [__dirname];
config.resolver.extraNodeModules = { ...(config.resolver.extraNodeModules || {}), '@': __dirname };
const resolveHarmonyRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('@/')) return context.resolveRequest(context, path.resolve(__dirname, moduleName.slice(2)), platform);
  if (moduleName === 'react-native-screens/src/native-stack/contexts/GHContext') {
    return context.resolveRequest(context, path.join(path.dirname(require.resolve('react-native-screens/package.json')), 'src/contexts'), platform);
  }
  return resolveHarmonyRequest(context, moduleName, platform);
};
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'cjs'])];

module.exports = config;
