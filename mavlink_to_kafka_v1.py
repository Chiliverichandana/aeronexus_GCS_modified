import json
import math
import time
from datetime import datetime, timezone

from kafka import KafkaProducer
from pymavlink import mavutil


DRONE_ID = "DRONE-001"

# MAVLink connection
MAVLINK_CONNECTION = "udpin:0.0.0.0:14554"

# MAVLINK_CONNECTION = "/dev/ttyUSB0"
# MAVLINK_CONNECTION = "serial:/dev/ttyUSB0:57600"

# Kafka
KAFKA_BOOTSTRAP_SERVERS = "localhost:9092"
TELEMETRY_TOPIC = "drone.telemetry"
WAYPOINT_TOPIC = "drone.waypoints"


# ---------------------------------------------------------------------------
# MAVLink connection
# ---------------------------------------------------------------------------

master = mavutil.mavlink_connection(MAVLINK_CONNECTION)

print("Waiting for MAVLink heartbeat...")
master.wait_heartbeat()

print(
    f"Connected to system={master.target_system}, "
    f"component={master.target_component}"
)


# ---------------------------------------------------------------------------
# Kafka producer
# ---------------------------------------------------------------------------

producer = KafkaProducer(
    bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
    value_serializer=lambda value: json.dumps(value).encode("utf-8"),
    key_serializer=lambda value: value.encode("utf-8"),
)


# ---------------------------------------------------------------------------
# Drone state
# ---------------------------------------------------------------------------

state = {
    "latitude": None,
    "longitude": None,
    "altitude": None,
    "heading": 0.0,
    "speed": 0.0,
    "roll": 0.0,
    "pitch": 0.0,
    "yaw": 0.0,
    "batteryPercentage": 0.0,
    "gpsSatellites": 0,
    "flightMode": "MANUAL",
    "armed": False,
    "status": "OK",
}


last_publish = 0.0
last_waypoint_publish = 0.0

WAYPOINT_INTERVAL = 30.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def normalize_degrees(value):
    return value % 360.0


def utc_timestamp():
    return (
        datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


# ---------------------------------------------------------------------------
# Get waypoints from MAVLink mission
# ---------------------------------------------------------------------------

def get_waypoints():
    """
    Request the mission/waypoints from the flight controller.

    Returns:
        list of waypoint dictionaries
    """

    print("Requesting mission waypoints...")

    # Request mission list
    master.mav.mission_request_list_send(
        master.target_system,
        master.target_component,
    )

    # Wait for MISSION_COUNT
    mission_count_message = master.recv_match(
        type="MISSION_COUNT",
        blocking=True,
        timeout=5,
    )

    if mission_count_message is None:
        print("Timed out waiting for MISSION_COUNT")
        return []

    mission_count = mission_count_message.count

    print(f"Mission contains {mission_count} items")

    if mission_count == 0:
        return []

    waypoints = []

    # Request each mission item
    for seq in range(mission_count):

        master.mav.mission_request_int_send(
            master.target_system,
            master.target_component,
            seq,
        )

        message = None
        deadline = time.monotonic() + 5

        while time.monotonic() < deadline:
            received = master.recv_match(
                type=[
                    "MISSION_ITEM_INT",
                    "MISSION_ITEM",
                ],
                blocking=True,
                timeout=1,
            )

            if received is None:
                continue

            if received.seq == seq:
                message = received
                break

        if message is None:
            print(f"Timed out waiting for waypoint {seq}")
            continue

        # MISSION_ITEM_INT coordinates are in 1e-7 degrees.
        if message.get_type() == "MISSION_ITEM_INT":
            latitude = message.x / 10_000_000.0
            longitude = message.y / 10_000_000.0
        else:
            # MISSION_ITEM uses floating point degrees.
            latitude = float(message.x)
            longitude = float(message.y)

        waypoint = {
            "sequence": int(message.seq),
            "latitude": latitude,
            "longitude": longitude,
            "altitude": float(message.z),
            "command": int(message.command),
            "frame": int(message.frame),
            "current": int(message.current),
            "autocontinue": int(message.autocontinue),
        }

        waypoints.append(waypoint)

    print(f"Received {len(waypoints)} mission items")

    return waypoints


# ---------------------------------------------------------------------------
# Push waypoints to Kafka
# ---------------------------------------------------------------------------

def publish_waypoints():
    """
    Fetch the latest waypoints and push the complete waypoint list to Kafka.
    """

    waypoints = get_waypoints()

    payload = {
        "droneId": DRONE_ID,
        "timestamp": utc_timestamp(),
        "waypoints": waypoints,
        "waypointCount": len(waypoints),
        "metadata": {
            "source": "pymavlink",
            "systemId": master.target_system,
            "componentId": master.target_component,
        },
    }

    producer.send(
        WAYPOINT_TOPIC,
        key=DRONE_ID,
        value=payload,
    )

    producer.flush()

    #print(
      #  f"Published {len(waypoints)} waypoints "
     #   f"to Kafka topic '{WAYPOINT_TOPIC}'"
    #)

   # print(json.dumps(payload, indent=2))


# ---------------------------------------------------------------------------
# Fetch and push waypoints immediately at startup
# ---------------------------------------------------------------------------

print("Fetching initial waypoints...")

publish_waypoints()

last_waypoint_publish = time.monotonic()


# ---------------------------------------------------------------------------
# Main MAVLink loop
# ---------------------------------------------------------------------------

while True:

    message = master.recv_match(
        type=[
            "GLOBAL_POSITION_INT",
            "ATTITUDE",
            "BATTERY_STATUS",
            "SYS_STATUS",
            "GPS_RAW_INT",
            "HEARTBEAT",
        ],
        blocking=True,
        timeout=1,
    )

    if message is not None:

        message_type = message.get_type()

        # ---------------------------------------------------------------
        # Position
        # ---------------------------------------------------------------

        if message_type == "GLOBAL_POSITION_INT":

            state["latitude"] = message.lat / 10_000_000.0

            state["longitude"] = message.lon / 10_000_000.0

            # relative_alt is millimeters
            state["altitude"] = max(
                0.0,
                message.relative_alt / 1000.0,
            )

            # vx/vy are centimeters per second
            state["speed"] = math.sqrt(
                (message.vx / 100.0) ** 2 +
                (message.vy / 100.0) ** 2
            )

            if message.hdg != 65535:
                state["heading"] = message.hdg / 100.0

        # ---------------------------------------------------------------
        # Attitude
        # ---------------------------------------------------------------

        elif message_type == "ATTITUDE":

            state["roll"] = math.degrees(message.roll)

            state["pitch"] = math.degrees(message.pitch)

            state["yaw"] = normalize_degrees(
                math.degrees(message.yaw)
            )

        # ---------------------------------------------------------------
        # Battery
        # ---------------------------------------------------------------

        elif message_type == "BATTERY_STATUS":

            if message.battery_remaining >= 0:
                state["batteryPercentage"] = float(
                    message.battery_remaining
                )

        elif message_type == "SYS_STATUS":

            if message.battery_remaining >= 0:
                state["batteryPercentage"] = float(
                    message.battery_remaining
                )

        # ---------------------------------------------------------------
        # GPS
        # ---------------------------------------------------------------

        elif message_type == "GPS_RAW_INT":

            if message.satellites_visible != 255:
                state["gpsSatellites"] = int(
                    message.satellites_visible
                )

        # ---------------------------------------------------------------
        # Heartbeat
        # ---------------------------------------------------------------

        elif message_type == "HEARTBEAT":

            state["flightMode"] = (
                master.flightmode or "MANUAL"
            )

            state["armed"] = bool(
                message.base_mode
                & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
            )

    now = time.monotonic()

    # ===================================================================
    # TELEMETRY - publish every 1 second
    # ===================================================================

    if (
        now - last_publish >= 1.0
        and state["latitude"] is not None
        and state["longitude"] is not None
        and state["altitude"] is not None
    ):

        payload = {
            "droneId": DRONE_ID,

            "timestamp": utc_timestamp(),

            "latitude": state["latitude"],
            "longitude": state["longitude"],
            "altitude": state["altitude"],

            "heading": state["heading"],
            "speed": state["speed"],

            "roll": state["roll"],
            "pitch": state["pitch"],
            "yaw": state["yaw"],

            "batteryPercentage": state["batteryPercentage"],
            "gpsSatellites": state["gpsSatellites"],

            "flightMode": state["flightMode"],
            "armed": state["armed"],
            "status": state["status"],

            "metadata": {
                "source": "pymavlink",
                "systemId": master.target_system,
                "componentId": master.target_component,
            },
        }

        producer.send(
            TELEMETRY_TOPIC,
            key=DRONE_ID,
            value=payload,
        )

        producer.flush()

        print(json.dumps(payload))

        last_publish = now

    # ===================================================================
    # WAYPOINTS - publish every 30 seconds
    # ===================================================================

    if now - last_waypoint_publish >= WAYPOINT_INTERVAL:

        try:
            publish_waypoints()

        except Exception as e:
            print(
                f"Error fetching/publishing waypoints: {e}"
            )

        last_waypoint_publish = now
