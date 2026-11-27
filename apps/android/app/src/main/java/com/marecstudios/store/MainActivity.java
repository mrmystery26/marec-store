package com.marecstudios.store;

import android.app.Activity;
import android.net.Uri;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import androidx.webkit.WebViewAssetLoader;

/**
 * Hosts the MAREC Store interface (the same web interface the Windows launcher uses) in a WebView.
 * The pages are served from the app's own files, so the app works the same with or without the web.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MarecStore";
    private WebView webView;
    // A marecstore:// link that arrived while the page was still loading.
    private String pendingLink;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF121316);
        setContentView(webView);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // keeps wishlist, notifications and preferences between launches
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportZoom(false);

        final WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (Hosts.isAppPage(url)) {
                    return false;
                }
                if (Hosts.isSafeExternal(url)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                        // No app can open this link.
                    }
                }
                return true; // the app itself never leaves its own pages
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "page-loaded " + url);
                if (pendingLink != null) {
                    String link = pendingLink;
                    pendingLink = null;
                    deliverLink(link);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "The web view process stopped; restarting the screen.");
                recreate();
                return true;
            }
        });

        webView.addJavascriptInterface(new NativeBridge(this, webView), "MarecAndroid");
        pendingLink = linkFrom(getIntent());
        webView.loadUrl(Hosts.APP_ORIGIN + "/assets/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String link = linkFrom(intent);
        if (link != null) {
            deliverLink(link);
        }
    }

    /** The marecstore://auth address the store sends the browser to after Google, or null. */
    private static String linkFrom(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return null;
        }
        Uri data = intent.getData();
        if (data == null) {
            return null;
        }
        String link = data.toString();
        return Hosts.isSignInLink(link) ? link : null;
    }

    /** Tells the page. The page only acts on it if it started a sign-in itself. */
    private void deliverLink(String link) {
        final String script = "window.__marecNative && window.__marecNative.on('deeplink',''," +
                "{url:" + JSONObject.quote(link) + "});";
        webView.post(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the app go back a screen first; only leave when it is already on its first screen.
        webView.evaluateJavascript(
                "(function(){return !!(window.MarecAndroidBack && window.MarecAndroidBack());})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) {
                            MainActivity.super.onBackPressed();
                        }
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
