package com.marecstudios.store;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Makes the store's HTTP requests on a background thread, outside the browser's cross-origin rules. */
final class NativeHttp {
    interface Result {
        /** status is 0 and error is set when the store could not be reached at all. */
        void done(int status, String body, String error);
    }

    private static final int MAX_BODY_BYTES = 8 * 1024 * 1024;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    void request(final String method, final String url, final String headersJson, final String body, final Result result) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setRequestMethod(method);
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(30000);
                    connection.setInstanceFollowRedirects(true);

                    JSONObject headers = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> names = headers.keys();
                    while (names.hasNext()) {
                        String name = names.next();
                        connection.setRequestProperty(name, headers.getString(name));
                    }
                    if (body != null && !body.isEmpty()) {
                        byte[] data = body.getBytes(StandardCharsets.UTF_8);
                        connection.setDoOutput(true);
                        connection.setFixedLengthStreamingMode(data.length);
                        try (OutputStream out = connection.getOutputStream()) {
                            out.write(data);
                        }
                    }

                    int status = connection.getResponseCode();
                    InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                    result.done(status, stream == null ? "" : readAll(stream), null);
                } catch (Exception e) {
                    String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    result.done(0, "", message);
                } finally {
                    if (connection != null) {
                        connection.disconnect();
                    }
                }
            }
        });
    }

    private static String readAll(InputStream stream) throws java.io.IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_BODY_BYTES) {
                    throw new java.io.IOException("The answer was too large.");
                }
            }
            return out.toString("UTF-8");
        }
    }
}
