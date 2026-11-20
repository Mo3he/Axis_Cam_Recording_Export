/*
 * Recording Export ACAP entry binary.
 *
 * The app is its web page: html/app.js calls the camera's own Edge Storage
 * VAPIX APIs with the signed-in user's browser session. This process only
 * keeps the app in the Running state; it opens no ports and stores nothing.
 */

#include <glib-unix.h>
#include <glib.h>
#include <signal.h>
#include <stdlib.h>
#include <syslog.h>

#define APP_NAME "Recording_Export"

static gboolean on_terminate(gpointer user_data) {
    g_main_loop_quit((GMainLoop *)user_data);
    return G_SOURCE_REMOVE;
}

int main(void) {
    openlog(APP_NAME, LOG_PID, LOG_USER);

    GMainLoop *main_loop = g_main_loop_new(NULL, FALSE);
    g_unix_signal_add(SIGTERM, on_terminate, main_loop);
    g_unix_signal_add(SIGINT, on_terminate, main_loop);

    syslog(LOG_INFO, "%s started", APP_NAME);
    g_main_loop_run(main_loop);

    g_main_loop_unref(main_loop);
    closelog();
    return EXIT_SUCCESS;
}
