const path = require('path');

// Keep in sync with build.appId: electron-builder strips build from packaged metadata.
const APP_ID = 'org.robotstem.desktop';
const APP_NAME = 'RobotSTEM';

function configureDesktopIdentity(app, platform = process.platform) {
  app.setName(APP_NAME);
  // Windows profiles and single-instance locks must not collide with Aily Project.
  // Leave legacy data untouched; retain the existing non-Windows profile locations.
  const profileName = platform === 'win32' ? APP_NAME : 'aily blockly';
  app.setPath('userData', path.join(app.getPath('appData'), profileName));
  if (platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
}

function getWindowIcon(app, platform = process.platform) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'public', platform === 'win32' ? 'robotstem.ico' : 'robotstem.png');
}

function configureWindowIdentity(window, platform = process.platform) {
  if (platform === 'win32') {
    // Explicit window identity takes precedence over inherited shortcut grouping.
    window.setAppDetails({ appId: APP_ID });
  }
}

module.exports = { APP_ID, APP_NAME, configureDesktopIdentity, configureWindowIdentity, getWindowIcon };
