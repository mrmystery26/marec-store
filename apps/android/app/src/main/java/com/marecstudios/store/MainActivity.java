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

import androidx.webkit.WebViewAssetLoader;

/**
 * Hosts the MAREC Store interface (the same web interface the Windows launcher uses) in a WebView.
 * The pages are served from the app's own files, so the app works the same with or without the web.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MarecStore";
    private WebView webView;

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
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.e(TAG, "The web view process stopped; restarting the screen.");
                recreate();
                return true;
            }
        });

        webView.addJavascriptInterface(new NativeBridge(this, webView), "MarecAndroid");
        webView.loadUrl(Hosts.APP_ORIGIN + "/assets/index.html");
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
