package com.energycalendar.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class CalendarTransportTest {
    @Test
    public void keepsOnlyCanonicalHttpsOriginInRelease() {
        assertEquals("https://calendar.example", CalendarTransport.origin("https://Calendar.Example:443/", false));
        assertEquals("https://calendar.example:8443", CalendarTransport.origin("https://calendar.example:8443", false));
        assertThrows(IllegalArgumentException.class, () -> CalendarTransport.origin("http://calendar.example", false));
        assertThrows(IllegalArgumentException.class, () -> CalendarTransport.origin("http://127.0.0.1:3001", false));
    }

    @Test
    public void permitsOnlyDebugLoopbackHttp() {
        assertEquals("http://127.0.0.1:3001", CalendarTransport.origin("http://127.0.0.1:3001", true));
        assertEquals("http://[::1]:3001", CalendarTransport.origin("http://[::1]:3001", true));
        assertThrows(IllegalArgumentException.class, () -> CalendarTransport.origin("http://192.168.1.2:3001", true));
        assertThrows(IllegalArgumentException.class, () -> CalendarTransport.origin("http://localhost.example", true));
    }

    @Test
    public void rejectsCredentialsAndNonOriginUrls() {
        for (String input : new String[] {
            "https://user@calendar.example", "https://calendar.example/path",
            "https://calendar.example?token=a", "https://calendar.example/#fragment",
            "https://calendar.example:65536", "//calendar.example"
        }) {
            assertThrows(input, IllegalArgumentException.class, () -> CalendarTransport.origin(input, true));
        }
    }
}
