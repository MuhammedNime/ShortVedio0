package com.shortsquiz.studio0;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends BridgeActivity {
    private static final int REQUEST_AUDIO_PERMISSION = 1001;
    private long lastBackPressAt = 0L;

    private static class PendingUpload {
        final File tempFile;
        final String fileName;
        final String mimeType;

        PendingUpload(File tempFile, String fileName, String mimeType) {
            this.tempFile = tempFile;
            this.fileName = fileName;
            this.mimeType = mimeType;
        }
    }

    private final Map<String, PendingUpload> pendingUploads = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().addJavascriptInterface(new AndroidNativeBridge(), "AndroidNativeBridge");
        }

        ensureAudioPermission();

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge != null && bridge.getWebView() != null) {
                    bridge.getWebView().evaluateJavascript(
                            "(function(){ try { return window.__handleAndroidBack ? Boolean(window.__handleAndroidBack()) : false; } catch(e) { return false; } })()",
                            value -> {
                                if ("true".equals(value)) {
                                    return;
                                }
                                long now = System.currentTimeMillis();
                                if (now - lastBackPressAt < 2000L) {
                                    finish();
                                } else {
                                    lastBackPressAt = now;
                                    Toast.makeText(
                                            MainActivity.this,
                                            "اضغط رجوع مرة أخرى للخروج",
                                            Toast.LENGTH_SHORT
                                    ).show();
                                }
                            }
                    );
                } else {
                    finish();
                }
            }
        });
    }

    private void ensureAudioPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    REQUEST_AUDIO_PERMISSION
            );
        }
    }

    private static String sanitizeFileName(String rawName) {
        String safe = (rawName == null ? "export.bin" : rawName).replaceAll("[^a-zA-Z0-9._-]", "_");
        return safe.isEmpty() ? "export.bin" : safe;
    }

    private static String sanitizeMimeType(String rawMime) {
        return (rawMime == null || rawMime.trim().isEmpty()) ? "application/octet-stream" : rawMime.trim();
    }

    private static byte[] decodeBase64Payload(String base64Data) {
        String clean = base64Data == null ? "" : base64Data;
        int commaIndex = clean.indexOf(",");
        if (commaIndex >= 0) {
            clean = clean.substring(commaIndex + 1);
        }
        return Base64.decode(clean, Base64.DEFAULT);
    }

    private String persistFileToDownloads(File sourceFile, String safeName, String safeMime) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
            values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ShortsQuizStudio");
            ContentResolver resolver = getContentResolver();
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("Failed to create MediaStore download entry");
            }
            try (InputStream in = new FileInputStream(sourceFile);
                 OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) {
                    throw new IllegalStateException("Failed to open download output stream");
                }
                byte[] buffer = new byte[65536];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                out.flush();
            }
        } else {
            File downloadsDir = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                    "ShortsQuizStudio"
            );
            if (!downloadsDir.exists()) {
                downloadsDir.mkdirs();
            }
            File outFile = new File(downloadsDir, safeName);
            try (InputStream in = new FileInputStream(sourceFile);
                 FileOutputStream fos = new FileOutputStream(outFile)) {
                byte[] buffer = new byte[65536];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    fos.write(buffer, 0, read);
                }
                fos.flush();
            }
            MediaScannerConnection.scanFile(
                    MainActivity.this,
                    new String[]{outFile.getAbsolutePath()},
                    new String[]{safeMime},
                    null
            );
        }

        runOnUiThread(() -> Toast.makeText(
                MainActivity.this,
                "تم حفظ الملف في التنزيلات: " + safeName,
                Toast.LENGTH_LONG
        ).show());
        return "{\"ok\":true,\"fileName\":\"" + safeName + "\"}";
    }

    private String launchShareIntent(File fileToShare, String safeMime) {
        Uri contentUri = FileProvider.getUriForFile(
                MainActivity.this,
                getPackageName() + ".fileprovider",
                fileToShare
        );
        runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(safeMime);
            intent.putExtra(Intent.EXTRA_STREAM, contentUri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(intent, "مشاركة / حفظ الملف"));
        });
        return "{\"ok\":true}";
    }

    public class AndroidNativeBridge {
        @JavascriptInterface
        public boolean requestAudioPermission() {
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                return true;
            }
            runOnUiThread(MainActivity.this::ensureAudioPermission);
            return false;
        }

        @JavascriptInterface
        public String beginSaveFile(String fileName, String mimeType) {
            try {
                String safeName = sanitizeFileName(fileName);
                String safeMime = sanitizeMimeType(mimeType);
                File tempDir = new File(getCacheDir(), "shared");
                if (!tempDir.exists()) {
                    tempDir.mkdirs();
                }
                String uploadId = UUID.randomUUID().toString();
                File tempFile = new File(tempDir, uploadId + "_" + safeName);
                if (tempFile.exists()) {
                    tempFile.delete();
                }
                pendingUploads.put(uploadId, new PendingUpload(tempFile, safeName, safeMime));
                return uploadId;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean appendSaveChunk(String uploadId, String base64Chunk) {
            PendingUpload upload = pendingUploads.get(uploadId);
            if (upload == null) return false;
            try {
                byte[] bytes = decodeBase64Payload(base64Chunk);
                try (FileOutputStream fos = new FileOutputStream(upload.tempFile, true)) {
                    fos.write(bytes);
                    fos.flush();
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public String finishSaveFile(String uploadId) {
            PendingUpload upload = pendingUploads.remove(uploadId);
            if (upload == null) {
                return "{\"ok\":false,\"error\":\"Upload session not found\"}";
            }
            try {
                String result = persistFileToDownloads(upload.tempFile, upload.fileName, upload.mimeType);
                upload.tempFile.delete();
                return result;
            } catch (Exception e) {
                upload.tempFile.delete();
                return "{\"ok\":false,\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
        }

        @JavascriptInterface
        public String finishShareFile(String uploadId) {
            PendingUpload upload = pendingUploads.remove(uploadId);
            if (upload == null) {
                return "{\"ok\":false,\"error\":\"Upload session not found\"}";
            }
            try {
                return launchShareIntent(upload.tempFile, upload.mimeType);
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
        }

        @JavascriptInterface
        public String saveFile(String base64Data, String fileName, String mimeType) {
            String safeName = sanitizeFileName(fileName);
            String safeMime = sanitizeMimeType(mimeType);
            File tempFile = null;
            try {
                byte[] bytes = decodeBase64Payload(base64Data);
                File tempDir = new File(getCacheDir(), "shared");
                if (!tempDir.exists()) {
                    tempDir.mkdirs();
                }
                tempFile = new File(tempDir, "tmp_" + safeName);
                try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                    fos.write(bytes);
                    fos.flush();
                }
                return persistFileToDownloads(tempFile, safeName, safeMime);
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            } finally {
                if (tempFile != null && tempFile.exists()) {
                    tempFile.delete();
                }
            }
        }

        @JavascriptInterface
        public String shareFile(String base64Data, String fileName, String mimeType) {
            String safeName = sanitizeFileName(fileName);
            String safeMime = sanitizeMimeType(mimeType);
            try {
                byte[] bytes = decodeBase64Payload(base64Data);
                File shareDir = new File(getCacheDir(), "shared");
                if (!shareDir.exists()) {
                    shareDir.mkdirs();
                }
                File outFile = new File(shareDir, safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                    fos.flush();
                }
                return launchShareIntent(outFile, safeMime);
            } catch (Exception e) {
                return "{\"ok\":false,\"error\":\"" + String.valueOf(e.getMessage()).replace("\"", "'") + "\"}";
            }
        }
    }
}
