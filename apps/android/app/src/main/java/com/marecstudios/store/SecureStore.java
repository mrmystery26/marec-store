package com.marecstudios.store;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import java.util.HashMap;
import java.util.Map;

/**
 * Keeps the login tokens encrypted with a key held in the Android Keystore. If the device cannot provide
 * that (rare), tokens are kept in memory only, so the player simply has to log in again next time.
 */
final class SecureStore {
    private final SharedPreferences prefs;
    private final Map<String, String> memory = new HashMap<>();

    SecureStore(Context context) {
        SharedPreferences created = null;
        try {
            String keyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
            created = EncryptedSharedPreferences.create(
                    "marec_secure",
                    keyAlias,
                    context,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        } catch (Exception e) {
            created = null;
        }
        prefs = created;
    }

    boolean isPersistent() {
        return prefs != null;
    }

    synchronized String get(String key) {
        return prefs != null ? prefs.getString(key, null) : memory.get(key);
    }

    synchronized void set(String key, String value) {
        if (prefs != null) {
            prefs.edit().putString(key, value).apply();
        } else {
            memory.put(key, value);
        }
    }

    synchronized void remove(String key) {
        if (prefs != null) {
            prefs.edit().remove(key).apply();
        } else {
            memory.remove(key);
        }
    }
}
