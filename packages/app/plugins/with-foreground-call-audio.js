const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withForegroundCallAudio(config) {
  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    manifest["uses-permission"] ??= [];
    manifest["uses-permission"].push(
      { $: { "android:name": "android.permission.BLUETOOTH", "android:maxSdkVersion": "30" } },
      { $: { "android:name": "android.permission.BLUETOOTH_CONNECT" } },
    );
    const application = manifest.application[0];
    application.service ??= [];
    // WebRTC includes screen sharing support; foreground audio never uses it.
    application.service.push({
      $: { "android:name": "com.oney.WebRTCModule.MediaProjectionService", "tools:node": "remove" },
    });
    return result;
  });
};
