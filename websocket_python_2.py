import json
import math
import os
import queue
import threading
import time
from datetime import datetime, timezone

from collections import deque

from kafka import KafkaProducer
import requests
import websocket

from pymavlink import mavutil


# ============================================================
# CONFIGURATION
# ============================================================

SERVER_HOST = os.getenv("DRONEIQ_HOST", "localhost")
SERVER_PORT = int(os.getenv("DRONEIQ_PORT", "8081"))

HTTP_BASE_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"
WS_URL = f"ws://{SERVER_HOST}:{SERVER_PORT}/ws/telemetry"
LOGIN_URL = f"{HTTP_BASE_URL}/api/auth/login"

# Use environment variables instead of hardcoding credentials.
USERNAME = os.getenv("DRONEIQ_USERNAME", "superadmin")
PASSWORD = os.getenv("DRONEIQ_PASSWORD", "admin123")

# This bridge is configured for ONE ArduPilot SITL vehicle.
DRONE_ID = os.getenv("DRONE_ID", "DRONE-001")

# Configure MAVProxy to forward this vehicle's MAVLink packets
# to UDP port 14555.
MAVLINK_CONNECTION = os.getenv(
    "MAVLINK_CONNECTION",
    "udpin:0.0.0.0:14555",
)

# Publish the simulator's actual MAVLink state to the backend's Kafka topic.
KAFKA_BOOTSTRAP_SERVERS = os.getenv(
    "KAFKA_BOOTSTRAP_SERVERS",
    "localhost:9092",
)
KAFKA_TELEMETRY_TOPIC = os.getenv(
    "KAFKA_TOPIC_TELEMETRY",
    "drone.telemetry",
)

# Timeouts
HEARTBEAT_TIMEOUT = 30
COMMAND_ACK_TIMEOUT = 8
STATE_CONFIRM_TIMEOUT = 10
TELEMETRY_PUBLISH_INTERVAL = 1.0

# Keep example takeoff requests within a conservative test range.
MIN_TAKEOFF_ALTITUDE = 1.0
MAX_TAKEOFF_ALTITUDE = 20.0
TAKEOFF_CLIMB_CONFIRMATION_METRES = 1.5
TAKEOFF_CLIMB_TIMEOUT = 30
LAND_DESCENT_CONFIRMATION_METRES = 0.5
LAND_DESCENT_TIMEOUT = 60


# ============================================================
# GLOBAL STATE
# ============================================================

JWT_TOKEN = None
ws_app = None
kafka_producer = None
kafka_publish_confirmed = threading.Event()

mav = None

# WebSocket connection and authentication state.
authenticated = threading.Event()
ws_send_lock = threading.Lock()

# MAVLink connection state.
mav_lock = threading.Lock()
state_condition = threading.Condition()

vehicle_state = {
    "heartbeat_received": False,
    "armed": None,
    "custom_mode": None,
    "relative_altitude_m": None,
    "last_heartbeat": None,
    "latitude": None,
    "longitude": None,
    "altitude": None,
    "heading": 0.0,
    "speed": 0.0,
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "battery_percentage": 0.0,
    "gps_satellites": 0,
    "flight_mode": "UNKNOWN",
}

# A single MAVLink reader distributes ACKs and telemetry state.
ack_lock = threading.Lock()
ack_waiters = {}

# Process commands sequentially to avoid conflicting flight actions.
command_queue = queue.Queue()

# Remember recent command IDs to avoid duplicate dispatch.
recent_command_ids = deque(maxlen=1000)
recent_command_ids_set = set()
command_ids_lock = threading.Lock()


# ============================================================
# SPRING BOOT HTTP LOGIN
# ============================================================

def login():
    if not PASSWORD:
        raise RuntimeError(
            "DRONEIQ_PASSWORD is not set. "
            "Set it before starting the bridge."
        )

    print("Logging in to Spring Boot...")

    response = requests.post(
        LOGIN_URL,
        json={
            "username": USERNAME,
            "password": PASSWORD,
        },
        timeout=10,
    )

    print("Login HTTP status:", response.status_code)
    response.raise_for_status()

    response_json = response.json()
    data = response_json.get("data")

    if not isinstance(data, dict):
        raise RuntimeError(
            "Login response does not contain a valid 'data' object."
        )

    token = data.get("token")

    if not token:
        raise RuntimeError(
            "Login succeeded, but the JWT token was missing."
        )

    print("JWT received successfully. Token not displayed.")

    return token


# ============================================================
# KAFKA TELEMETRY
# ============================================================

def connect_to_kafka():
    producer = KafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS.split(","),
        key_serializer=lambda value: value.encode("utf-8"),
        value_serializer=lambda value: json.dumps(value).encode("utf-8"),
        max_block_ms=5000,
        request_timeout_ms=5000,
        retries=3,
    )

    try:
        partitions = producer.partitions_for(KAFKA_TELEMETRY_TOPIC)
        if not partitions:
            raise RuntimeError(
                f"Kafka topic {KAFKA_TELEMETRY_TOPIC!r} is unavailable."
            )
    except Exception as exc:
        producer.close(timeout=5)
        raise RuntimeError(
            f"Cannot connect to Kafka at {KAFKA_BOOTSTRAP_SERVERS} "
            f"or access topic {KAFKA_TELEMETRY_TOPIC!r}: {exc}"
        ) from exc

    print(
        f"Kafka connected: {KAFKA_BOOTSTRAP_SERVERS}, "
        f"topic={KAFKA_TELEMETRY_TOPIC}"
    )
    return producer


def telemetry_publisher():
    while True:
        time.sleep(TELEMETRY_PUBLISH_INTERVAL)

        with state_condition:
            snapshot = dict(vehicle_state)

        last_heartbeat = snapshot["last_heartbeat"]
        if (
            snapshot["latitude"] is None
            or snapshot["longitude"] is None
            or last_heartbeat is None
            or time.monotonic() - last_heartbeat > 3
        ):
            continue

        payload = {
            "droneId": DRONE_ID,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "latitude": snapshot["latitude"],
            "longitude": snapshot["longitude"],
            "altitude": snapshot["altitude"],
            "heading": snapshot["heading"],
            "speed": snapshot["speed"],
            "roll": snapshot["roll"],
            "pitch": snapshot["pitch"],
            "yaw": snapshot["yaw"],
            "batteryPercentage": snapshot["battery_percentage"],
            "gpsSatellites": snapshot["gps_satellites"],
            "flightMode": snapshot["flight_mode"],
            "armed": snapshot["armed"],
            "status": "OK",
            "metadata": {
                "source": "pymavlink",
                "systemId": mav.target_system,
                "componentId": mav.target_component,
            },
        }

        try:
            future = kafka_producer.send(
                KAFKA_TELEMETRY_TOPIC,
                key=DRONE_ID,
                value=payload,
            )
            future.add_callback(report_first_kafka_publish)
            future.add_errback(
                lambda exc: print("[Kafka] Telemetry publish failed:", exc)
            )
        except Exception as exc:
            print("[Kafka] Telemetry publish failed:", exc)


def report_first_kafka_publish(record_metadata):
    if not kafka_publish_confirmed.is_set():
        kafka_publish_confirmed.set()
        print(
            f"[Kafka] First telemetry record confirmed: "
            f"{record_metadata.topic} partition={record_metadata.partition} "
            f"offset={record_metadata.offset}"
        )


# ============================================================
# WEBSOCKET SEND HELPERS
# ============================================================

def send_ws_message(message):
    """
    Send a JSON message safely.

    Returns False if the WebSocket is not open or sending fails.
    """
    if ws_app is None or not authenticated.is_set():
        return False

    try:
        with ws_send_lock:
            if ws_app.sock is None or not ws_app.sock.connected:
                return False

            ws_app.send(json.dumps(message))

        return True

    except Exception as exc:
        print("[WebSocket] Send failed:", exc)
        return False


def send_command_status(
    command_id,
    drone_id,
    status,
    detail=None,
):
    """
    Report command progress to Spring Boot.

    Backend support for COMMAND_ACK is required.
    """
    message = {
        "type": "COMMAND_ACK",
        "commandId": command_id,
        "droneId": drone_id,
        "status": status,
        "timestamp": time.time(),
    }

    if detail:
        message["message"] = str(detail)

    if not send_ws_message(message):
        print(
            f"[COMMAND] Could not report status {status} "
            f"for {command_id}"
        )


# ============================================================
# MAVLINK CONNECTION
# ============================================================

def connect_to_sitl():
    """
    Connect to ArduPilot SITL through a MAVLink UDP endpoint.

    Start SITL and configure the appropriate MAVProxy output first.
    """
    global mav

    print()
    print("=" * 55)
    print("Connecting to ArduPilot SITL")
    print("MAVLink endpoint:", MAVLINK_CONNECTION)
    print("=" * 55)

    mav = mavutil.mavlink_connection(
        MAVLINK_CONNECTION,
        autoreconnect=True,
    )

    heartbeat = mav.wait_heartbeat(
        timeout=HEARTBEAT_TIMEOUT,
    )

    if heartbeat is None:
        raise TimeoutError(
            f"No MAVLink heartbeat received within {HEARTBEAT_TIMEOUT}s "
            f"on {MAVLINK_CONNECTION}. Confirm SITL is running and, at the "
            "MAVProxy prompt connected to that vehicle, run "
            "`output add <bridge-computer-IP>:14553` (use "
            "`127.0.0.1` only when the bridge is on the same computer). "
            "The MAVProxy output port must match this bridge's "
            "MAVLINK_CONNECTION."
        )

    if heartbeat.type == mavutil.mavlink.MAV_TYPE_GCS:
        raise RuntimeError(
            "Received a GCS heartbeat instead of a vehicle heartbeat."
        )

    with state_condition:
        vehicle_state["heartbeat_received"] = True

        vehicle_state["armed"] = bool(
            heartbeat.base_mode
            & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
        )

        vehicle_state["custom_mode"] = heartbeat.custom_mode
        vehicle_state["last_heartbeat"] = time.monotonic()

        state_condition.notify_all()

    print("MAVLink heartbeat received.")
    print("Target system:", mav.target_system)
    print("Target component:", mav.target_component)
    print("Initial armed state:", vehicle_state["armed"])

    # Start the only thread that reads MAVLink messages.
    threading.Thread(
        target=mavlink_reader,
        daemon=True,
        name="mavlink-reader",
    ).start()


# ============================================================
# MAVLINK READER
# ============================================================

def mavlink_reader():
    """
    Read MAVLink messages in one place.

    This prevents separate command threads from consuming each
    other's COMMAND_ACK or heartbeat messages.
    """
    print("[MAVLink] Reader started.")

    while True:
        try:
            message = mav.recv_match(
                blocking=True,
                timeout=1,
            )

            if message is None:
                continue

            message_type = message.get_type()

            if message_type == "BAD_DATA":
                continue

            if (
                mav.target_system
                and message.get_srcSystem() != mav.target_system
            ):
                continue

            # ------------------------------------------------
            # Heartbeat: armed state and flight mode
            # ------------------------------------------------

            if message_type == "HEARTBEAT":

                with state_condition:
                    vehicle_state["heartbeat_received"] = True

                    vehicle_state["armed"] = bool(
                        message.base_mode
                        & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
                    )

                    vehicle_state["custom_mode"] = message.custom_mode
                    vehicle_state["last_heartbeat"] = time.monotonic()
                    vehicle_state["flight_mode"] = (
                        mav.flightmode or "UNKNOWN"
                    )

                    state_condition.notify_all()

            # ------------------------------------------------
            # Position: relative altitude
            # ------------------------------------------------

            elif message_type == "GLOBAL_POSITION_INT":

                relative_altitude_m = message.relative_alt / 1000.0

                with state_condition:
                    vehicle_state["relative_altitude_m"] = (
                        relative_altitude_m
                    )
                    vehicle_state["latitude"] = message.lat / 10_000_000.0
                    vehicle_state["longitude"] = message.lon / 10_000_000.0
                    vehicle_state["altitude"] = max(0.0, relative_altitude_m)
                    vehicle_state["speed"] = (
                        (message.vx / 100.0) ** 2
                        + (message.vy / 100.0) ** 2
                    ) ** 0.5
                    if message.hdg != 65535:
                        vehicle_state["heading"] = message.hdg / 100.0

                    state_condition.notify_all()

            elif message_type == "ATTITUDE":
                with state_condition:
                    vehicle_state["roll"] = math.degrees(message.roll)
                    vehicle_state["pitch"] = math.degrees(message.pitch)
                    vehicle_state["yaw"] = (
                        math.degrees(message.yaw) % 360.0
                    )

            elif message_type in {"BATTERY_STATUS", "SYS_STATUS"}:
                battery_percentage = message.battery_remaining
                if battery_percentage >= 0:
                    with state_condition:
                        vehicle_state["battery_percentage"] = float(
                            battery_percentage
                        )

            elif message_type == "GPS_RAW_INT":
                if message.satellites_visible != 255:
                    with state_condition:
                        vehicle_state["gps_satellites"] = int(
                            message.satellites_visible
                        )

            # ------------------------------------------------
            # Command ACK: deliver to matching waiter
            # ------------------------------------------------

            elif message_type == "COMMAND_ACK":

                command_id = message.command

                with ack_lock:
                    waiter = ack_waiters.get(command_id)

                if waiter is not None:
                    waiter.put(message)

                print(
                    f"[MAVLink] COMMAND_ACK command={command_id}, "
                    f"result={message.result}"
                )

        except Exception as exc:
            print("[MAVLink] Reader error:", exc)
            time.sleep(0.5)


# ============================================================
# STATE HELPERS
# ============================================================

def get_vehicle_state():
    with state_condition:
        return dict(vehicle_state)


def wait_for_state(predicate, timeout):
    """
    Wait for a state condition updated by the MAVLink reader.
    """
    deadline = time.monotonic() + timeout

    with state_condition:
        while True:
            snapshot = dict(vehicle_state)

            if predicate(snapshot):
                return snapshot

            remaining = deadline - time.monotonic()

            if remaining <= 0:
                raise TimeoutError(
                    f"Vehicle state was not confirmed within {timeout}s. "
                    f"Last state: {snapshot}"
                )

            state_condition.wait(timeout=remaining)


def ensure_fresh_heartbeat():
    """
    Fail safely if the vehicle heartbeat is stale.
    """
    state = get_vehicle_state()
    last_heartbeat = state.get("last_heartbeat")

    if last_heartbeat is None:
        raise RuntimeError("No vehicle heartbeat has been received.")

    age = time.monotonic() - last_heartbeat

    if age > 5:
        raise RuntimeError(
            f"Vehicle heartbeat is stale ({age:.1f}s old)."
        )


def is_armed():
    return get_vehicle_state().get("armed") is True


# ============================================================
# MAVLINK COMMAND HELPERS
# ============================================================

def send_command_long(
    command_id,
    param1=0,
    param2=0,
    param3=0,
    param4=0,
    param5=0,
    param6=0,
    param7=0,
    timeout=COMMAND_ACK_TIMEOUT,
):
    """
    Send COMMAND_LONG and wait for its matching ACK.

    Only the MAVLink reader receives messages. This function waits
    on a dedicated queue for the relevant command acknowledgement.
    """
    ensure_fresh_heartbeat()

    waiter = queue.Queue(maxsize=10)

    with ack_lock:
        ack_waiters[command_id] = waiter

    try:
        with mav_lock:
            mav.mav.command_long_send(
                mav.target_system,
                mav.target_component,
                command_id,
                0,
                param1,
                param2,
                param3,
                param4,
                param5,
                param6,
                param7,
            )

        deadline = time.monotonic() + timeout

        while True:
            remaining = deadline - time.monotonic()

            if remaining <= 0:
                raise TimeoutError(
                    f"No COMMAND_ACK received for MAV_CMD {command_id}."
                )

            try:
                ack = waiter.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(
                    f"No COMMAND_ACK received for MAV_CMD {command_id}."
                )

            result = ack.result

            if result == mavutil.mavlink.MAV_RESULT_IN_PROGRESS:
                # Command is still in progress. Keep waiting for
                # the final ACK, if the autopilot provides one.
                continue

            if result == mavutil.mavlink.MAV_RESULT_ACCEPTED:
                return ack

            raise RuntimeError(
                f"Autopilot rejected MAV_CMD {command_id}; "
                f"MAV_RESULT={result}"
            )

    finally:
        with ack_lock:
            if ack_waiters.get(command_id) is waiter:
                del ack_waiters[command_id]


# ============================================================
# FLIGHT MODE
# ============================================================

def set_copter_mode(mode_name, timeout=10):
    """
    Request an ArduCopter mode and verify it using HEARTBEAT.

    SET_MODE does not use COMMAND_ACK in the same way as COMMAND_LONG.
    Therefore, the resulting heartbeat mode is checked instead.
    """
    ensure_fresh_heartbeat()

    mode_mapping = mav.mode_mapping()

    if not mode_mapping or mode_name not in mode_mapping:
        raise ValueError(
            f"Flight mode {mode_name!r} is not available. "
            f"Available modes: {list(mode_mapping or {})}"
        )

    mode_id = mode_mapping[mode_name]

    print(f"[MAVLink] Requesting flight mode {mode_name}")

    with mav_lock:
        mav.mav.set_mode_send(
            mav.target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_id,
        )

    wait_for_state(
        lambda state: state["custom_mode"] == mode_id,
        timeout,
    )

    print(f"[MAVLink] Flight mode confirmed: {mode_name}")


# ============================================================
# ARM / DISARM
# ============================================================

def arm_or_disarm(arm):
    """
    Request normal arming/disarming and verify HEARTBEAT state.

    This deliberately does not use ArduPilot's force-disarm mechanism.
    """
    ensure_fresh_heartbeat()

    desired_state = bool(arm)

    if vehicle_state.get("armed") is desired_state:
        print(
            "[MAVLink] Vehicle already in desired armed state:",
            desired_state,
        )
        return

    command_id = (
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM
    )

    send_command_long(
        command_id=command_id,
        param1=1 if arm else 0,
    )

    wait_for_state(
        lambda state: state["armed"] is desired_state,
        STATE_CONFIRM_TIMEOUT,
    )

    print(
        "[MAVLink] Armed state confirmed:",
        desired_state,
    )


# ============================================================
# TAKEOFF
# ============================================================

def takeoff(altitude):
    """
    Request a guided takeoff.

    A command ACK is not proof of reaching the target altitude.
    """
    try:
        altitude = float(altitude)
    except (TypeError, ValueError):
        raise ValueError("Takeoff altitude must be a number.")

    if not MIN_TAKEOFF_ALTITUDE <= altitude <= MAX_TAKEOFF_ALTITUDE:
        raise ValueError(
            f"Takeoff altitude must be between "
            f"{MIN_TAKEOFF_ALTITUDE} and {MAX_TAKEOFF_ALTITUDE} metres."
        )

    ensure_fresh_heartbeat()

    set_copter_mode("GUIDED")

    if not is_armed():
        arm_or_disarm(True)

    state = wait_for_state(
        lambda snapshot: snapshot["relative_altitude_m"] is not None,
        STATE_CONFIRM_TIMEOUT,
    )
    initial_altitude = state["relative_altitude_m"]
    climb_threshold = min(
        TAKEOFF_CLIMB_CONFIRMATION_METRES,
        altitude * 0.8,
    )

    print(f"[MAVLink] Requesting takeoff to {altitude} metres")

    command_id = mavutil.mavlink.MAV_CMD_NAV_TAKEOFF

    send_command_long(
        command_id=command_id,
        param1=0,
        param2=0,
        param3=0,
        param4=0,
        param5=0,
        param6=0,
        param7=altitude,
    )

    confirmed_state = wait_for_state(
        lambda snapshot: (
            snapshot["relative_altitude_m"] is not None
            and snapshot["relative_altitude_m"]
            >= initial_altitude + climb_threshold
        ),
        TAKEOFF_CLIMB_TIMEOUT,
    )
    print(
        "[MAVLink] Takeoff climb confirmed at "
        f"{confirmed_state['relative_altitude_m']:.1f} metres "
        f"(target {altitude:.1f} metres)."
    )


# ============================================================
# LAND
# ============================================================

def land():
    """
    Request LAND mode, then verify the vehicle has begun descending.
    """
    ensure_fresh_heartbeat()

    state = get_vehicle_state()
    initial_altitude = state.get("relative_altitude_m")
    if initial_altitude is None:
        state = wait_for_state(
            lambda snapshot: snapshot["relative_altitude_m"] is not None,
            STATE_CONFIRM_TIMEOUT,
        )
        initial_altitude = state["relative_altitude_m"]

    set_copter_mode("LAND")

    if initial_altitude > LAND_DESCENT_CONFIRMATION_METRES:
        descended_state = wait_for_state(
            lambda snapshot: (
                snapshot["relative_altitude_m"] is not None
                and snapshot["relative_altitude_m"]
                <= initial_altitude - LAND_DESCENT_CONFIRMATION_METRES
            ),
            LAND_DESCENT_TIMEOUT,
        )
        print(
            "[MAVLink] Landing descent confirmed: "
            f"{initial_altitude:.1f} m -> "
            f"{descended_state['relative_altitude_m']:.1f} m."
        )
        return descended_state

    print("[MAVLink] LAND mode confirmed; vehicle is already near ground level.")
    return get_vehicle_state()


# ============================================================
# COMMAND VALIDATION
# ============================================================

ALLOWED_COMMANDS = {
    "ARM",
    "DISARM",
    "TAKEOFF",
    "LAND",
}


def remember_command_id(command_id):
    """
    Reject command IDs already in the recent history.
    """
    with command_ids_lock:
        if command_id in recent_command_ids_set:
            return False

        if len(recent_command_ids) == recent_command_ids.maxlen:
            oldest = recent_command_ids.popleft()
            recent_command_ids_set.discard(oldest)

        recent_command_ids.append(command_id)
        recent_command_ids_set.add(command_id)

        return True


def validate_command(message):
    command_id = message.get("commandId")
    drone_id = message.get("droneId")
    command_type = str(
        message.get("commandType", "")
    ).upper()

    parameters = message.get("parameters") or {}

    if not isinstance(parameters, dict):
        raise ValueError("parameters must be a JSON object.")

    if not command_id:
        raise ValueError("commandId is required.")

    if not drone_id:
        raise ValueError("droneId is required.")

    if drone_id != DRONE_ID:
        raise ValueError(
            f"This bridge controls {DRONE_ID}, not {drone_id}."
        )

    if command_type not in ALLOWED_COMMANDS:
        raise ValueError(
            f"Unsupported command: {command_type}"
        )

    if not remember_command_id(str(command_id)):
        raise ValueError(
            f"Duplicate commandId: {command_id}"
        )

    return str(command_id), drone_id, command_type, parameters


# ============================================================
# COMMAND EXECUTION
# ============================================================

def execute_command(message):
    """
    Execute a command and report its status to Spring Boot.
    """
    command_id = message.get("commandId")
    drone_id = message.get("droneId")

    try:
        command_id, drone_id, command_type, parameters = (
            validate_command(message)
        )

        print()
        print("=" * 55)
        print(f"COMMAND: {command_type}")
        print(f"Drone:   {drone_id}")
        print(f"ID:      {command_id}")
        print("=" * 55)

        send_command_status(
            command_id,
            drone_id,
            "RECEIVED",
        )

        # All flight commands execute sequentially.
        if command_type == "ARM":
            arm_or_disarm(True)

            send_command_status(
                command_id,
                drone_id,
                "STATE_CONFIRMED",
                "Armed state confirmed by MAVLink heartbeat.",
            )

        elif command_type == "DISARM":
            arm_or_disarm(False)

            send_command_status(
                command_id,
                drone_id,
                "STATE_CONFIRMED",
                "Disarmed state confirmed by MAVLink heartbeat.",
            )

        elif command_type == "TAKEOFF":
            altitude = parameters.get("altitude", 5)

            takeoff(altitude)

            send_command_status(
                command_id,
                drone_id,
                "STATE_CONFIRMED",
                "MAVLink telemetry confirmed takeoff climb.",
            )

        elif command_type == "LAND":
            land()

            send_command_status(
                command_id,
                drone_id,
                "STATE_CONFIRMED",
                "LAND mode confirmed; descent was observed or the vehicle "
                "was already near ground level.",
            )

    except Exception as exc:
        print(
            f"[COMMAND] Command {command_id} failed:",
            exc,
        )

        # Report failure if the command ID and drone ID are present.
        if command_id and drone_id:
            send_command_status(
                command_id,
                drone_id,
                "FAILED",
                str(exc),
            )


def command_worker():
    """
    One worker serializes flight commands to avoid conflicting actions.
    """
    print("[COMMAND] Worker started.")

    while True:
        message = command_queue.get()

        try:
            execute_command(message)
        finally:
            command_queue.task_done()


# ============================================================
# WEBSOCKET CALLBACKS
# ============================================================

def on_open(ws):
    print()
    print("=" * 55)
    print("WebSocket connected:", WS_URL)
    print("=" * 55)

    # AUTH must be the first application message.
    ws.send(json.dumps({
        "type": "AUTH",
        "token": JWT_TOKEN,
    }))

    print("[WebSocket] AUTH message sent.")


def on_message(ws, message):
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        print("[WebSocket] Invalid JSON received.")
        return

    message_type = data.get("type")

    # --------------------------------------------------------
    # Authentication
    # --------------------------------------------------------

    if message_type == "AUTH_SUCCESS":
        authenticated.set()

        print("[WebSocket] Authentication successful.")

        # Register this bridge with Spring Boot.
        registered = send_ws_message({
            "type": "REGISTER_DRONE",
            "droneId": DRONE_ID,
        })

        if registered:
            print(f"[WebSocket] Registration requested for {DRONE_ID}")
        else:
            print("[WebSocket] Failed to send drone registration.")

    # --------------------------------------------------------
    # Commands sent from Spring Boot
    # --------------------------------------------------------
    elif message_type == "DRONE_REGISTERED":
        registered_drone_id = message.get("droneId")

        if registered_drone_id == DRONE_ID:
            print(
                f"[WebSocket] Command bridge registered successfully "
                f"for {registered_drone_id}."
            )
        else:
            print(
                f"[WebSocket] WARNING: Registered drone ID "
                f"does not match configured ID: {registered_drone_id}"
            )
    elif message_type in {"AUTH_FAILURE", "AUTH_REQUIRED"}:
        authenticated.clear()
        print(
            "[WebSocket] Authentication failed:",
            data.get("message", message_type),
        )

    elif message_type == "COMMAND":
        if not authenticated.is_set():
            print(
                "[COMMAND] Rejected: WebSocket is not authenticated."
            )
            return

        command_id = data.get("commandId")
        drone_id = data.get("droneId")

        print(
            f"[COMMAND] Received command={data.get('commandType')} "
            f"drone={drone_id} id={command_id}"
        )

        command_queue.put(data)

    # --------------------------------------------------------
    # Telemetry published by Spring Boot
    # --------------------------------------------------------

    elif message_type == "TELEMETRY":
        print(
            "[WebSocket] Telemetry received from server:",
            data.get("droneId"),
        )

    # --------------------------------------------------------
    # Other protocol messages
    # --------------------------------------------------------

    elif message_type == "PONG":
        pass

    elif message_type == "ERROR":
        print(
            "[WebSocket] Server error:",
            data.get("message"),
        )

    else:
        print(
            "[WebSocket] Unhandled message type:",
            message_type,
        )


def on_error(ws, error):
    print("[WebSocket] Error:", error)


def on_close(ws, close_status_code, close_msg):
    authenticated.clear()

    print()
    print("=" * 55)
    print("WebSocket connection closed")
    print("Status:", close_status_code)
    print("Message:", close_msg)
    print("=" * 55)


# ============================================================
# WEBSOCKET KEEPALIVE
# ============================================================

def keepalive_worker():
    """
    Send application-level PING messages every 30 seconds.
    """
    while True:
        time.sleep(30)

        if authenticated.is_set():
            send_ws_message({
                "type": "PING",
            })


# ============================================================
# MAIN
# ============================================================

def main():
    global JWT_TOKEN, ws_app, kafka_producer

    # 1. Confirm Kafka is available before accepting flight commands.
    kafka_producer = connect_to_kafka()

    # 2. Authenticate with Spring Boot.
    JWT_TOKEN = login()

    # 3. Connect to ArduPilot SITL.
    connect_to_sitl()

    # 4. Start the serialized command worker.
    threading.Thread(
        target=command_worker,
        daemon=True,
        name="command-worker",
    ).start()

    # 5. Publish actual vehicle telemetry to Kafka.
    threading.Thread(
        target=telemetry_publisher,
        daemon=True,
        name="telemetry-publisher",
    ).start()

    # 6. Start WebSocket keepalive.
    threading.Thread(
        target=keepalive_worker,
        daemon=True,
        name="websocket-keepalive",
    ).start()

    # 7. Connect the WebSocket client.
    ws_app = websocket.WebSocketApp(
        WS_URL,
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close,
    )

    print()
    print("DroneIQ Python bridge starting")
    print("Drone ID:", DRONE_ID)
    print("WebSocket:", WS_URL)
    print("MAVLink:", MAVLINK_CONNECTION)
    print("Kafka:", KAFKA_BOOTSTRAP_SERVERS, KAFKA_TELEMETRY_TOPIC)
    print()

    # Automatic reconnection can be added after ensuring that
    # stale commands are not replayed and the session is reauthorized.
    ws_app.run_forever()


if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        print("\nBridge stopped by user.")

    except Exception as exc:
        print("\nBridge startup failed:", exc)
        raise SystemExit(1) from exc
    finally:
        if kafka_producer is not None:
            try:
                kafka_producer.close(timeout=5)
            except Exception as exc:
                print("[Kafka] Producer shutdown failed:", exc)
