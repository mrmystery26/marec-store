package com.marecstudios.store;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HostsTest {
    @Test
    public void onlyTheAppsOwnPagesCountAsAppPages() {
        assertTrue(Hosts.isAppPage("https://appassets.androidplatform.net/assets/index.html"));
        assertFalse(Hosts.isAppPage("https://appassets.androidplatform.net.evil.example/assets/index.html"));
        assertFalse(Hosts.isAppPage("http://appassets.androidplatform.net/assets/index.html"));
        assertFalse(Hosts.isAppPage(null));
    }

    @Test
    public void onlyWebAndMailLinksOpenOutsideTheApp() {
        assertTrue(Hosts.isSafeExternal("https://marec.example/help"));
        assertTrue(Hosts.isSafeExternal("MAILTO:support@marec.example"));
        assertFalse(Hosts.isSafeExternal("file:///data/data/com.marecstudios.store/secret"));
        assertFalse(Hosts.isSafeExternal("intent://scan/#Intent;end"));
        assertFalse(Hosts.isSafeExternal(null));
    }

    @Test
    public void checksumsMustBeLowerCaseHex64() {
        assertTrue(Hosts.isSha256("a".repeat(64)));
        assertFalse(Hosts.isSha256("A".repeat(64)));
        assertFalse(Hosts.isSha256("abc"));
        assertFalse(Hosts.isSha256(null));
    }

    @Test
    public void downloadedFileNamesCannotEscapeTheDownloadFolder() {
        assertEquals("alpha.apk", Hosts.safeFileName("alpha"));
        assertEquals(".._.._etc_passwd.apk", Hosts.safeFileName("../../etc/passwd"));
        assertEquals("app.apk", Hosts.safeFileName(""));
        assertEquals("app.apk", Hosts.safeFileName(null));
    }
}
