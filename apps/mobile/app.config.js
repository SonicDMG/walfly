const appJson = require('./app.json');

// Expo Router's dev-mode static SSR preview (`web.output: "static"`) crashes
// Metro's incremental bundler for this app (upstream Expo/Metro bug: the
// second render of expo-router/node/render.js loses React's internals -
// "Cannot read properties of undefined (reading 'ReactCurrentDispatcher')").
// `expo export` (production builds) is unaffected, so only override the dev
// server to skip static pre-rendering and serve a client-rendered SPA shell.
module.exports = () => {
  const config = appJson.expo;
  if (process.env.EXPO_START === '1') {
    return {
      ...config,
      web: {
        ...config.web,
        output: 'single',
      },
    };
  }
  return config;
};
