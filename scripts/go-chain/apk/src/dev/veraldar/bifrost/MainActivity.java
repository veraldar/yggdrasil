package dev.veraldar.bifrost;

import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * veraldar bifrost — the branch (go-chain Lane C, 10-30).
 * First run: ask once for the trunk origin (the VPS URL from the receipt).
 * Every run: load it in a WebView; the /pair + /bridge pages do the rest
 * (device token, QR, chat, voice). Mic permission is granted to the page so
 * the bridge can carry voice; everything else is the trunk's own UI.
 */
public class MainActivity extends Activity {
    private static final String PREF = "bifrost";
    private static final String KEY_URL = "trunk_url";
    private static final int REQ_MIC = 7;
    private WebView web;
    private PermissionRequest pendingMic;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        SharedPreferences p = getSharedPreferences(PREF, MODE_PRIVATE);
        String url = p.getString(KEY_URL, "");
        if (url.isEmpty()) { askForTrunk(p); return; }
        openTrunk(p, url);
    }

    private void askForTrunk(final SharedPreferences p) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 96, 48, 48);
        box.setBackgroundColor(Color.parseColor("#101014"));

        TextView t = new TextView(this);
        t.setText("bifrost\n\nPaste the TRUNK URL from your deploy receipt\n(https://your-trunk.example.com)");
        t.setTextColor(Color.WHITE); t.setTextSize(16);
        box.addView(t);

        final EditText in = new EditText(this);
        in.setHint("https://…");
        in.setTextColor(Color.WHITE); in.setHintTextColor(0xFF888888);
        box.addView(in);

        Button go = new Button(this);
        go.setText("Save and open bifrost");
        go.setOnClickListener(v -> {
            String u = in.getText().toString().trim();
            if (u.isEmpty()) return;
            if (!u.startsWith("http")) u = "https://" + u;
            while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            p.edit().putString(KEY_URL, u).apply();
            setContentView(new WebView(this)); // clear the form
            openTrunk(p, u);
        });
        box.addView(go);
        setContentView(box);
    }

    private void openTrunk(SharedPreferences p, String url) {
        requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, REQ_MIC);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // localStorage: the device token
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(Color.parseColor("#101014"));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> req.grant(req.getResources())); // mic for the bridge
            }
        });
        web.setLayoutParams(new ViewGroup.LayoutParams(-1, -1));
        setContentView(web);
        web.loadUrl(url); // the trunk: /pair first (receipt URL), then chat/bridge
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override public void onRequestPermissionsResult(int rc, String[] perm, int[] res) {
        if (rc == REQ_MIC && pendingMic != null) {
            runOnUiThread(() -> pendingMic.grant(pendingMic.getResources()));
            pendingMic = null;
        }
    }
}
