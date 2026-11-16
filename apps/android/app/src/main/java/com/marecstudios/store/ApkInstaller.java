package com.marecstudios.store;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Downloads an Android game, checks its SHA-256, and hands it to Android's own package installer.
 * Android shows its own confirmation screen; this class never installs anything silently.
 */
final class ApkInstaller {
    interface Listener {
        void progress(long done, long total);

        void done();

        void error(String code, String message);
    }

    private final Activity activity;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final Map<String, AtomicBoolean> cancels = new ConcurrentHashMap<>();

    ApkInstaller(Activity activity) {
        this.activity = activity;
    }

    boolean canInstall() {
        return Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls();
    }

    void cancel(String id) {
        AtomicBoolean flag = cancels.get(id);
        if (flag != null) {
            flag.set(true);
        }
    }

    void download(final String id, final String url, final String sha256, final String fileName, final Listener listener) {
        if (!url.startsWith("https://") || !Hosts.isSha256(sha256)) {
            listener.error("BAD_BUILD", "The store sent an Android build that cannot be checked, so it was not downloaded.");
            return;
        }
        if (!canInstall()) {
            // Ask first, before spending the player's data on a download that could not be installed.
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()));
                    activity.startActivity(settings);
                }
            });
            listener.error("NEEDS_PERMISSION", "Allow MAREC Store to install apps on the screen that just opened, then tap Install again.");
            return;
        }

        final AtomicBoolean cancelled = new AtomicBoolean(false);
        cancels.put(id, cancelled);
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    File file = fetch(url, sha256, Hosts.safeFileName(fileName), cancelled, listener);
                    if (file != null) {
                        startInstaller(file);
                        listener.done();
                    }
                } catch (Exception e) {
                    String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    listener.error("DOWNLOAD_FAILED", "The download failed: " + message);
                } finally {
                    cancels.remove(id);
                }
            }
        });
    }

    /** Returns the verified file, or null after reporting a cancel or a failed check. */
    private File fetch(String url, String sha256, String fileName, AtomicBoolean cancelled, Listener listener) throws Exception {
        File dir = new File(activity.getCacheDir(), "apk");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new java.io.IOException("Cannot create the download folder.");
        }
        File partial = new File(dir, fileName + ".part");
        File target = new File(dir, fileName);

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(true);
            int status = connection.getResponseCode();
            if (status != 200) {
                throw new java.io.IOException("The download server answered " + status + ".");
            }
            long total = connection.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long done = 0;
            long lastReport = 0;
            byte[] buffer = new byte[16384];
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (cancelled.get()) {
                        partial.delete();
                        listener.error("CANCELLED", "Download cancelled.");
                        return null;
                    }
                    out.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    done += read;
                    long now = System.currentTimeMillis();
                    if (now - lastReport > 250) {
                        lastReport = now;
                        listener.progress(done, total);
                    }
                }
            }
            listener.progress(done, total > 0 ? total : done);

            String actual = String.format("%064x", new BigInteger(1, digest.digest()));
            if (!actual.equals(sha256)) {
                partial.delete();
                listener.error("HASH_MISMATCH", "The downloaded file did not match the store's checksum, so it was deleted.");
                return null;
            }
            if (target.exists() && !target.delete()) {
                throw new java.io.IOException("Cannot replace the old download.");
            }
            if (!partial.renameTo(target)) {
                throw new java.io.IOException("Cannot finish the download.");
            }
            return target;
        } finally {
            connection.disconnect();
        }
    }

    private void startInstaller(final File file) {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(intent);
            }
        });
    }
}
