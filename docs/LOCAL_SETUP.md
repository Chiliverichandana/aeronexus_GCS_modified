# DroneIQ Local Development Setup Guide

Follow this guide to get the DroneIQ Ground Control Station backend running on your local machine.

---

## 1. Prerequisites

Ensure you have installed:
- **Java Development Kit (JDK)**: Java 21 or higher
- **Maven**: 3.9+ (or use the included `./mvnw` wrapper)
- **Docker & Docker Compose**: Docker 24+ and Docker Compose v2+
- **Git**

---

## 2. Environment Configuration

Copy the example environment template:

```bash
cp .env.example .env
```

Key environment variables:
| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `SPRING_PROFILES_ACTIVE` | `dev` | Active Spring profile |
| `SERVER_PORT` | `8080` | Application HTTP/WebSocket port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USER` / `DB_PASSWORD` | `droneiq` / `droneiq_password` | Database credentials |
| `KAFKA_BOOTSTRAP_SERVERS` | `localhost:9092` | Local Kafka broker |
| `SIMULATOR_ENABLED` | `true` | Runs built-in realistic mock drone telemetry |
| `STORAGE_S3_ENABLED` | `false` | Set to `true` when AWS credentials are provided |

---

## 3. Starting Local Infrastructure with Docker Compose

DroneIQ provides a self-contained local stack with **PostgreSQL 16** and **Apache Kafka (KRaft mode)**:

```bash
docker compose up -d
```

Verify that all services are running and healthy:

```bash
docker compose ps
```

You should see:
- `droneiq-postgres`: Port `5432` (healthy)
- `droneiq-kafka`: Port `9092` (healthy)

---

## 4. Running the Spring Boot Backend

Start the application using the Maven wrapper:

```bash
# On Linux / macOS
./mvnw spring-boot:run

# On Windows (PowerShell)
.\mvnw.cmd spring-boot:run
```

Once started, the application will:
1. Automatically execute Flyway migrations creating tables `users` and `drones`.
2. Seed initial credentials:
   - **Admin**: `admin` / `admin123` (Role: `ADMIN`)
   - **Operator**: `operator` / `operator123` (Role: `OPERATOR`)
3. Seed default fleet: `DRONE-001`, `DRONE-002`, `DRONE-003`.
4. Start the mock telemetry simulator generating smooth flight physics at 1Hz.

---

## 5. Testing REST APIs with Swagger UI

1. Open your browser and navigate to:
   [http://localhost:8080/swagger-ui.html](http://localhost:8080/swagger-ui.html)
2. Use `POST /api/auth/login` with:
   ```json
   {
     "username": "admin",
     "password": "admin123"
   }
   ```
3. Copy the returned `token`.
4. Click the green **Authorize** button at the top right, paste `Bearer <token>`, and click **Authorize**.
5. Test:
   - `GET /api/drones` - Lists the registered drone fleet.
   - `GET /api/drones/{droneId}/telemetry/latest` - Returns the real-time coordinates, altitude, speed, and battery.
   - `GET /api/telemetry/latest` - Returns latest state for all active drones.

---

## 6. Testing Real-Time WebSocket Streaming

### Option A: Using Browser Developer Console (No tools required)

Open your browser's Developer Tools Console (`F12`), paste the following snippet, and replace `<TOKEN>` with your JWT:

```javascript
const token = "<TOKEN>";
const ws = new WebSocket("ws://localhost:8080/ws/telemetry");

ws.onopen = () => {
    console.log("Connected to DroneIQ WebSocket!");
    // Send first-message authentication
    ws.send(JSON.stringify({ type: "AUTH", token: token }));
};

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "TELEMETRY") {
        console.log(`[Telemetry] Drone: ${msg.droneId} | Alt: ${msg.data.altitude}m | Bat: ${msg.data.batteryPercentage}% | Lat: ${msg.data.latitude} | Lon: ${msg.data.longitude}`);
    } else {
        console.log("[Server Event]", msg);
    }
};

ws.onclose = (e) => console.log("WebSocket closed:", e.code, e.reason);
```

### Option B: Using `wscat` CLI

```bash
# Install wscat if needed: npm install -g wscat
wscat -c ws://localhost:8080/ws/telemetry

# Send first-message authentication within 5 seconds:
{"type":"AUTH","token":"<YOUR_JWT_TOKEN>"}

# Subscribe to a specific drone:
{"type":"SUBSCRIBE","droneId":"DRONE-001"}
```

### Option C: Python MAVLink command bridge (SITL)

The bridge sends flight commands to ArduPilot SITL over MAVLink and publishes
the vehicle's live MAVLink telemetry to the backend's Kafka topic. Start local
infrastructure and the Spring Boot backend first so Kafka and the
`drone.telemetry` topic are available. Then, at the MAVProxy prompt connected
to the vehicle, forward MAVLink to the computer running the bridge:

```text
output add <bridge-computer-IP>:14553
```

If SITL/MAVProxy and the bridge are on the same computer, use
`output add 127.0.0.1:14553`. The bridge listens on `udpin:0.0.0.0:14553`;
allow inbound UDP port `14553` through the bridge computer's firewall. If you
change `MAVLINK_CONNECTION`, update the MAVProxy output address and port to
match. The bridge checks Kafka and stops with a diagnostic if Kafka is
unavailable or no vehicle heartbeat arrives within 30 seconds.

In PowerShell, from the repository root, install dependencies and run the
bridge:

```powershell
python -m pip install -r requirements.txt
$env:DRONEIQ_HOST = "localhost"
$env:DRONEIQ_PORT = "8081"
$env:DRONE_ID = "DRONE-001"
$env:KAFKA_BOOTSTRAP_SERVERS = "localhost:9092"
python .\websocket_python_2.py
```

The bridge itself publishes MAVLink telemetry to Kafka; do not also run
`mavlink_to_kafka_v1.py` for the same vehicle unless you intentionally want
duplicate telemetry records. Keep the backend's `SIMULATOR_ENABLED=false`
when validating the SITL data so mock telemetry does not compete with the real
vehicle state.

The emergency DISARM control is relayed to the bridge as a normal MAVLink
disarm request. The autopilot's safety checks remain enabled, and the UI only
confirms the disarmed state after live telemetry reports it.

If the seeded login is unavailable, set `DRONEIQ_USERNAME` and
`DRONEIQ_PASSWORD` to valid backend credentials before starting the bridge.
Keep this connected to SITL for testing; flight commands can arm and move the
vehicle.

---

## 7. Running Tests

Run the complete automated test suite (Unit + Integration Tests with in-memory H2 database):

```bash
./mvnw clean test
```
