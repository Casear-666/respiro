package com.energycalendar.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONException;

final class CalendarSessionStore {
    private static final String KEY_ALIAS = "energy-calendar-session-v1";
    private static final String METADATA = "profile";
    private static final String CREDENTIAL = "credential";

    static final class Session {
        final String origin;
        final JSObject user;
        final String cookie;

        Session(String origin, JSObject user, String cookie) {
            this.origin = origin;
            this.user = user;
            this.cookie = cookie;
        }

        JSObject metadata() {
            return new JSObject().put("origin", origin).put("user", user);
        }
    }

    private final SharedPreferences preferences;
    private Session active;
    private boolean loaded;

    CalendarSessionStore(Context context) {
        preferences = context.getSharedPreferences("calendar-session", Context.MODE_PRIVATE);
    }

    synchronized Session read() {
        if (loaded) return active;
        loaded = true;
        String stored = preferences.getString(METADATA, null);
        if (stored == null) return null;
        try {
            JSObject record = new JSObject(stored);
            String origin = record.getString("origin");
            JSObject user = record.getJSObject("user");
            String encrypted = preferences.getString(CREDENTIAL, "");
            if (origin == null || user == null || user.getString("id") == null) return null;
            String cookie = "";
            if (!encrypted.isEmpty()) {
                try {
                    cookie = decrypt(encrypted, stored);
                } catch (GeneralSecurityException | IOException | IllegalArgumentException invalid) {
                    // Keep the offline profile accessible if Android invalidated the credential.
                }
            }
            active = new Session(origin, user, cookie);
        } catch (JSONException invalid) {
            active = null;
        }
        return active;
    }

    synchronized Session replace(Session session) throws GeneralSecurityException, IOException {
        Session previous = read();
        SharedPreferences.Editor change = preferences.edit();
        if (session == null) {
            change.remove(METADATA).remove(CREDENTIAL);
        } else {
            String metadata = session.metadata().toString();
            change.putString(METADATA, metadata).putString(CREDENTIAL, encrypt(session.cookie, metadata));
        }
        if (!change.commit()) throw new IOException("无法保存本机会话");
        active = session;
        return previous;
    }

    private static SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    private static String encrypt(String cookie, String metadata) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(metadata.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(cookie.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private static String decrypt(String record, String metadata) throws GeneralSecurityException, IOException {
        String[] parts = record.split("\\.", 2);
        if (parts.length != 2) throw new IOException("登录会话无效");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        cipher.updateAAD(metadata.getBytes(StandardCharsets.UTF_8));
        byte[] bytes = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
