/*
 * Commander V1 Linux passive libei receiver.
 *
 * This process consumes only the inherited EIS fd from XDG InputCapture.
 * It never sends input and never prints keycodes, text, pointer coordinates,
 * device names, or raw event payloads. It emits bounded JSONL lifecycle
 * receipts for the parent Portal owner-session controller.
 *
 * A successful receipt is NOT a takeover grant on its own. The parent must
 * independently observe Portal::Activated and match activation_id to the
 * DEVICE_START_EMULATING sequence emitted by this receiver.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <inttypes.h>
#include <poll.h>
#include <sys/prctl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <libei.h>

static volatile sig_atomic_t stop_requested = 0;

static void on_signal(int signo) {
    (void)signo;
    stop_requested = 1;
}

static int parse_u32(const char *s, uint32_t *out) {
    char *end = NULL;
    errno = 0;
    unsigned long value = strtoul(s, &end, 10);
    if (errno || !s[0] || !end || *end || value > UINT32_MAX)
        return -1;
    *out = (uint32_t)value;
    return 0;
}

static void emit_error(const char *code) {
    printf("{\"kind\":\"error\",\"code\":\"%s\"}\n", code);
}

static void emit_simple(const char *kind) {
    printf("{\"kind\":\"%s\"}\n", kind);
}

static int validate_fd(int fd) {
    int type = 0;
    socklen_t len = sizeof(type);
    if (fd < 3 || fcntl(fd, F_GETFD) < 0)
        return -1;
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) != 0)
        return -1;
    if (type != SOCK_STREAM && type != SOCK_SEQPACKET)
        return -1;
    int flags = fcntl(fd, F_GETFD);
    if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0)
        return -1;
    return 0;
}

static int process_events(struct ei *ctx, uint32_t expected_sequence,
                          bool *matched_sequence, unsigned int *reported_activity_capabilities) {
    struct ei_event *event;
    while ((event = ei_get_event(ctx)) != NULL) {
        enum ei_event_type type = ei_event_get_type(event);
        struct ei_device *device = ei_event_get_device(event);
        switch (type) {
        case EI_EVENT_CONNECT:
            emit_simple("eis_connected");
            break;
        case EI_EVENT_DISCONNECT:
            ei_event_unref(event);
            emit_simple("eis_disconnected");
            return 70;
        case EI_EVENT_SEAT_ADDED:
            emit_simple("eis_seat_available");
            break;
        case EI_EVENT_SEAT_REMOVED:
            emit_simple("eis_seat_removed");
            break;
        case EI_EVENT_DEVICE_ADDED:
            if (device) {
                unsigned int caps = 0;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER))
                    caps |= 1u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE))
                    caps |= 2u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_KEYBOARD))
                    caps |= 4u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_TOUCH))
                    caps |= 8u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_SCROLL))
                    caps |= 16u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_BUTTON))
                    caps |= 32u;
                printf("{\"kind\":\"eis_device_added\",\"device_type\":%u,"
                       "\"capabilities\":%u}\n",
                       (unsigned int)ei_device_get_type(device), caps);
            }
            break;
        case EI_EVENT_DEVICE_REMOVED:
            emit_simple("eis_device_removed");
            break;
        case EI_EVENT_DEVICE_PAUSED:
            emit_simple("eis_device_paused");
            break;
        case EI_EVENT_DEVICE_RESUMED:
            emit_simple("eis_device_resumed");
            break;
        case EI_EVENT_DEVICE_START_EMULATING: {
            uint32_t sequence = ei_event_emulating_get_sequence(event);
            if (sequence != expected_sequence) {
                ei_event_unref(event);
                emit_error("EIS_ACTIVATION_SEQUENCE_MISMATCH");
                return 71;
            }
            if (!device || ei_device_get_type(device) != EI_DEVICE_TYPE_PHYSICAL) {
                emit_simple("eis_non_physical_device_ignored");
                break;
            }
            unsigned int caps = 0;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER)) caps |= 1u;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE)) caps |= 2u;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_KEYBOARD)) caps |= 4u;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_TOUCH)) caps |= 8u;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_SCROLL)) caps |= 16u;
            if (ei_device_has_capability(device, EI_DEVICE_CAP_BUTTON)) caps |= 32u;
            *matched_sequence = true;
            printf("{\"kind\":\"eis_activation_sequence_matched\","
                   "\"activation_id\":%" PRIu32 ",\"device_type\":%u,"
                   "\"capabilities\":%u}\n", sequence,
                   (unsigned int)ei_device_get_type(device), caps);
            break;
        }
        case EI_EVENT_DEVICE_STOP_EMULATING:
            emit_simple("eis_device_stop_emulating");
            break;
        case EI_EVENT_POINTER_MOTION:
        case EI_EVENT_POINTER_MOTION_ABSOLUTE:
        case EI_EVENT_BUTTON_BUTTON:
        case EI_EVENT_SCROLL_DELTA:
        case EI_EVENT_SCROLL_DISCRETE:
        case EI_EVENT_KEYBOARD_KEY:
        case EI_EVENT_TOUCH_DOWN:
        case EI_EVENT_TOUCH_UP:
        case EI_EVENT_TOUCH_MOTION:
            /* Record only that a physical device produced an event. Never log payload. */
            if (device && ei_device_get_type(device) == EI_DEVICE_TYPE_PHYSICAL) {
                unsigned int caps = 0;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER)) caps |= 1u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE)) caps |= 2u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_KEYBOARD)) caps |= 4u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_TOUCH)) caps |= 8u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_SCROLL)) caps |= 16u;
                if (ei_device_has_capability(device, EI_DEVICE_CAP_BUTTON)) caps |= 32u;
                if ((caps & ~*reported_activity_capabilities) != 0) {
                    *reported_activity_capabilities |= caps;
                    printf("{\"kind\":\"eis_physical_activity\",\"capabilities\":%u,\"device_type\":%u}\n",
                           caps, (unsigned int)ei_device_get_type(device));
                }
            }
            break;
        default:
            /* Deliberately ignore all raw input data. */
            break;
        }
        ei_event_unref(event);
    }
    return 0;
}

int main(int argc, char **argv) {
    int fd = -1;
    uint32_t expected_sequence = 0;
    uint32_t timeout_ms = 30000;
    uint32_t lease_ms = 60000;
    bool activation_id_set = false;
    static const struct option options[] = {
        {"fd", required_argument, NULL, 'f'},
        {"activation-id", required_argument, NULL, 'a'},
        {"timeout-ms", required_argument, NULL, 't'},
        {"lease-ms", required_argument, NULL, 'l'},
        {"help", no_argument, NULL, 'h'},
        {NULL, 0, NULL, 0}
    };
    int opt;
    while ((opt = getopt_long(argc, argv, "f:a:t:l:", options, NULL)) != -1) {
        uint32_t parsed = 0;
        switch (opt) {
        case 'h':
            puts("Usage: gui-libei-receiver --fd N --activation-id N [--timeout-ms 1000..120000] [--lease-ms 10000..120000]");
            return 0;
        case 'f':
            if (parse_u32(optarg, &parsed) != 0 || parsed > INT32_MAX) {
                emit_error("INVALID_FD_ARGUMENT");
                return 64;
            }
            fd = (int)parsed;
            break;
        case 'a':
            if (parse_u32(optarg, &expected_sequence) != 0) {
                emit_error("INVALID_ACTIVATION_ID");
                return 64;
            }
            activation_id_set = true;
            break;
        case 't':
            if (parse_u32(optarg, &timeout_ms) != 0 ||
                timeout_ms < 1000 || timeout_ms > 120000) {
                emit_error("INVALID_TIMEOUT");
                return 64;
            }
            break;
        case 'l':
            if (parse_u32(optarg, &lease_ms) != 0 ||
                lease_ms < 10000 || lease_ms > 120000) {
                emit_error("INVALID_LEASE");
                return 64;
            }
            break;
        default:
            emit_error("INVALID_ARGUMENTS");
            return 64;
        }
    }
    if (fd < 3 || !activation_id_set || optind != argc) {
        emit_error("FD_AND_ACTIVATION_ID_REQUIRED");
        return 64;
    }
    if (validate_fd(fd) != 0) {
        emit_error("EIS_FD_INVALID");
        close(fd);
        return 65;
    }

    pid_t parent_pid = getppid();
    if (parent_pid <= 1 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 ||
        getppid() != parent_pid) {
        close(fd);
        emit_error("PARENT_LIFECYCLE_GUARD_FAILED");
        return 70;
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGHUP, on_signal);
    setvbuf(stdout, NULL, _IOLBF, 0);

    struct ei *ctx = ei_new_receiver(NULL);
    if (!ctx) {
        close(fd);
        emit_error("LIBEI_RECEIVER_CREATE_FAILED");
        return 70;
    }
    ei_configure_name(ctx, "Commander V1 GUI input receiver");
    int rc = ei_setup_backend_fd(ctx, fd);
    if (rc != 0) {
        ei_unref(ctx);
        emit_error("LIBEI_BACKEND_SETUP_FAILED");
        return 70;
    }

    struct pollfd pfd = {.fd = ei_get_fd(ctx), .events = POLLIN};
    if (pfd.fd < 0) {
        ei_unref(ctx);
        emit_error("LIBEI_POLL_FD_INVALID");
        return 70;
    }

    struct timespec start_ts;
    if (clock_gettime(CLOCK_MONOTONIC, &start_ts) != 0) {
        ei_unref(ctx);
        emit_error("MONOTONIC_CLOCK_UNAVAILABLE");
        return 70;
    }
    bool matched_sequence = false;
    unsigned int reported_activity_capabilities = 0;
    struct timespec activated_ts = {0};
    emit_simple("eis_receiver_started");

    int exit_code = 0;
    while (!stop_requested) {
        int polled = poll(&pfd, 1, 250);
        if (polled < 0) {
            if (errno == EINTR)
                continue;
            emit_error("EIS_POLL_FAILED");
            exit_code = 70;
            break;
        }
        if (polled == 0) {
            struct timespec now_ts;
            if (clock_gettime(CLOCK_MONOTONIC, &now_ts) != 0) {
                emit_error("MONOTONIC_CLOCK_UNAVAILABLE");
                exit_code = 70;
                break;
            }
            const struct timespec *timer_start = matched_sequence ? &activated_ts : &start_ts;
            int64_t elapsed_ns =
                ((int64_t)now_ts.tv_sec - (int64_t)timer_start->tv_sec) * 1000000000LL +
                ((int64_t)now_ts.tv_nsec - (int64_t)timer_start->tv_nsec);
            uint64_t elapsed_ms = elapsed_ns < 0 ? 0u : (uint64_t)elapsed_ns / 1000000u;
            if (!matched_sequence && elapsed_ms >= timeout_ms) {
                emit_error("EIS_RECEIVER_TIMEOUT");
                exit_code = 72;
                break;
            }
            if (matched_sequence && elapsed_ms >= lease_ms) {
                emit_error("EIS_RECEIVER_LEASE_EXPIRED");
                exit_code = 73;
                break;
            }
            continue;
        }
        if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
            emit_error("EIS_TRANSPORT_CLOSED");
            exit_code = 70;
            break;
        }
        if (pfd.revents & POLLIN) {
            bool was_matched = matched_sequence;
            ei_dispatch(ctx);
            exit_code = process_events(ctx, expected_sequence, &matched_sequence,
                                       &reported_activity_capabilities);
            if (exit_code != 0)
                break;
            if (!was_matched && matched_sequence &&
                clock_gettime(CLOCK_MONOTONIC, &activated_ts) != 0) {
                emit_error("MONOTONIC_CLOCK_UNAVAILABLE");
                exit_code = 70;
                break;
            }
        }
        /* Keep the receiver alive after activation. The parent terminates
           it on Portal Deactivated/Closed, STOP, revocation or lease expiry. */
    }

    ei_unref(ctx);
    if (stop_requested) {
        emit_simple("eis_receiver_stopped");
        return 0;
    }
    return exit_code;
}
