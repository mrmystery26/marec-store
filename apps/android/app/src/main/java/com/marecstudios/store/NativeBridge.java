package com.marecstudios.store;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * What the app's web pages may ask Android to do. It is exposed to JavaScript as window.MarecAndroid,
 * and the page only ever loads our own files (see MainActivity), so nothing else can call it.
 * Answers go back through window.__marecNative.on(type, id, payload).
 */
final class NativeBridge {
    private static final Set<String> SECURE_KEYS = new HashSet<>(Arrays.asList("tokens"));
    private static final Set<String> SETTING_KEYS = new HashSet<>(Arrays.asList("apiBase"));

    private final Activity activity;
    private final WebView webView;
    private final SecureStore secure;
    private final SharedPreferences settings;
    private final NativeHttp http = new NativeHttp();
    private final ApkInstaller installer;

    NativeBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.secure = new SecureStore(activity);
        this.settings = activity.getSharedPreferences("marec_settings", Context.MODE_PRIVATE);
        this.installer = new ApkInstaller(activity);
    }

    private static JSONObject json(Object... pairs) {
        JSONObject object = new JSONObject();
        try {
            for (int i = 0; i + 1 < pairs.length; i += 2) {
                object.put((String) pairs[i], pairs[i + 1]);
            }
        } catch (JSONException ignored) {
            // Only plain strings, numbers and booleans are put in, so this cannot happen.
        }
        return object;
    }

    private void emit(String type, String id, JSONObject payload) {
        final String script = "window.__marecNative && window.__marecNative.on("
                + JSONObject.quote(type) + "," + JSONObject.quote(id) + "," + payload.toString() + ");";
        webView.post(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    @JavascriptInterface
    public String info() {
        return json(
                "platform", "android",
                "versionName", BuildConfig.VERSION_NAME,
                "versionCode", BuildConfig.VERSION_CODE,
                "commit", BuildConfig.BUILD_COMMIT,
                "buildDate", BuildConfig.BUILD_DATE,
                "defaultApiBase", BuildConfig.DEFAULT_API_BASE,
                "applicationId", BuildConfig.APPLICATION_ID,
                "allowCleartext", BuildConfig.ALLOW_CLEARTEXT,
                "secureStorage", secure.isPersistent(),
                "canInstallApks", installer.canInstall(),
                "sdk", Build.VERSION.SDK_INT).toString();
    }

    @JavascriptInterface
    public String secureGet(String key) {
        return SECURE_KEYS.contains(key) ? secure.get(key) : null;
    }

    @JavascriptInterface
    public void secureSet(String key, String value) {
        if (SECURE_KEYS.contains(key) && value != null) {
            secure.set(key, value);
        }
    }

    @JavascriptInterface
    public void secureRemove(String key) {
        if (SECURE_KEYS.contains(key)) {
            secure.remove(key);
        }
    }

    @JavascriptInterface
    public String settingGet(String key) {
        return SETTING_KEYS.contains(key) ? settings.getString(key, null) : null;
    }

    @JavascriptInterface
    public void settingSet(String key, String value) {
        if (SETTING_KEYS.contains(key) && value != null) {
            settings.edit().putString(key, value).apply();
        }
    }

    @JavascriptInterface
    public void httpRequest(final String id, String method, String url, String headersJson, String body) {
        boolean allowed = url != null && (url.startsWith("https://") || (BuildConfig.ALLOW_CLEARTEXT && url.startsWith("http://")));
        if (!allowed) {
            emit("http", id, json("status", 0, "body", "", "error", "This address is not allowed."));
            return;
        }
        http.request(method, url, headersJson, body, new NativeHttp.Result() {
            @Override
            public void done(int status, String responseBody, String error) {
                JSONObject payload = json("status", status, "body", responseBody);
                if (error != null) {
                    try {
                        payload.put("error", error);
                    } catch (JSONException ignored) {
                        // not reachable for a plain string
                    }
                }
                emit("http", id, payload);
            }
        });
    }

    @JavascriptInterface
    public void downloadApk(final String id, String url, String sha256, String fileName) {
        installer.download(id, url, sha256, fileName, new ApkInstaller.Listener() {
            @Override
            public void progress(long done, long total) {
                emit("apk", id, json("state", "progress", "done", done, "total", total));
            }

            @Override
            public void done() {
                emit("apk", id, json("state", "done"));
            }

            @Override
            public void error(String code, String message) {
                emit("apk", id, json("state", "error", "code", code, "message", message));
            }
        });
    }

    @JavascriptInterface
    public void cancelDownload(String id) {
        installer.cancel(id);
    }

    @JavascriptInterface
    public void openExternal(final String url) {
        if (!Hosts.isSafeExternal(url)) {
            return;
        }
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignored) {
                    // No app can open this link.
                }
            }
        });
    }
}
