package com.marecstudios.store;

import java.util.Locale;
import java.util.regex.Pattern;

/** Small rules about which addresses and names the app accepts. Plain Java so it can be unit tested. */
final class Hosts {
    /** The address the app's own pages are served from (see MainActivity). */
    static final String APP_ORIGIN = "https://appassets.androidplatform.net";

    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");

    private Hosts() {
    }

    static boolean isAppPage(String url) {
        return url != null && (url.equals(APP_ORIGIN) || url.startsWith(APP_ORIGIN + "/"));
    }

    /** Links that may be opened in the browser or mail app. Nothing else is ever opened from a page. */
    static boolean isSafeExternal(String url) {
        if (url == null) {
            return false;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:");
    }

    /** The address the store sends the browser to after Google: marecstore://auth, with an optional query. */
    static boolean isSignInLink(String url) {
        if (url == null) {
            return false;
        }
        String prefix = "marecstore://auth";
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith(prefix)) {
            return false;
        }
        return lower.length() == prefix.length()
                || lower.charAt(prefix.length()) == '?'
                || lower.charAt(prefix.length()) == '/';
    }

    static boolean isSha256(String value) {
        return value != null && SHA256.matcher(value).matches();
    }

    /** A file name with no folders in it: letters, digits, dot, dash and underscore, ending in .apk. */
    static String safeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (cleaned.isEmpty()) {
            cleaned = "app";
        }
        return cleaned.endsWith(".apk") ? cleaned : cleaned + ".apk";
    }
}
