package com.droneiq.command.service;

import com.droneiq.command.dto.FlightCommandRequest;
import com.droneiq.command.dto.FlightCommandResponse;
import com.droneiq.command.entity.FlightCommand;
import com.droneiq.command.repository.FlightCommandRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

import java.util.Map;

@Service
public class FlightCommandService {

    private final FlightCommandRepository commandRepository;
    private final DroneCommandWebSocketService droneCommandWebSocketService;
    private final ObjectMapper objectMapper;

    public FlightCommandService(
            FlightCommandRepository commandRepository,
            DroneCommandWebSocketService droneCommandWebSocketService,
            ObjectMapper objectMapper
    ) {
        this.commandRepository = commandRepository;
        this.droneCommandWebSocketService = droneCommandWebSocketService;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public FlightCommandResponse executeRoutineCommand(
            FlightCommandRequest request,
            String pilotUsername
    ) {
        String droneId = request.droneId();
        String commandType = request.commandType().toUpperCase();

        // 1. Save the request as pending, NOT executed.
        FlightCommand command = new FlightCommand(
                droneId,
                commandType,
                false,
                pilotUsername,
                "PENDING",
                request.getEffectivePayloadJson()
        );

        FlightCommand saved = commandRepository.save(command);

        // 2. Decode the optional command parameters.
        Map<String, Object> parameters = parseParameters(
                request.getEffectivePayloadJson()
        );

        // 3. Dispatch to the bridge registered for this drone.
        try {
            droneCommandWebSocketService.sendCommand(
                    droneId,
                    String.valueOf(saved.getId()),
                    commandType,
                    parameters
            );

            // Update the database status to SENT here.
            // Use your entity's status setter and repository save,
            // or a repository update method, if available.
            //
            // Do not set EXECUTED here.

        } catch (RuntimeException ex) {
            // Persist FAILED using your entity/repository's
            // status-update mechanism, then propagate the error.
            throw ex;
        }

        return FlightCommandResponse.fromEntity(saved);
    }

    private Map<String, Object> parseParameters(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return Map.of();
        }

        try {
            return objectMapper.readValue(
                    payloadJson,
                    new TypeReference<Map<String, Object>>() {}
            );
        } catch (Exception ex) {
            throw new IllegalArgumentException(
                    "Invalid command payload JSON",
                    ex
            );
        }
    }

        @Transactional
    public FlightCommandResponse executeOverrideCommand(FlightCommandRequest request, String managerUsername) {
            String commandType = request.commandType().toUpperCase();
            boolean disarmRequest = "FORCE_DISARM".equals(commandType)
                    || "DISARM".equals(commandType);

            FlightCommand command = new FlightCommand(
                    request.droneId(),
                    commandType,
                    true,
                    managerUsername,
                    disarmRequest ? "OVERRIDE_PENDING" : "OVERRIDE_EXECUTED",
                    request.getEffectivePayloadJson()
            );
            FlightCommand saved = commandRepository.save(command);

            if (disarmRequest) {
                droneCommandWebSocketService.sendCommand(
                        request.droneId(),
                        String.valueOf(saved.getId()),
                        "DISARM",
                        parseParameters(request.getEffectivePayloadJson())
                );
            }

            return FlightCommandResponse.fromEntity(saved);
        }

    @Transactional(readOnly = true)
    public List<FlightCommandResponse> getCommandHistory(String droneId) {
        List<FlightCommand> commands = (droneId != null && !droneId.isBlank())
                ? commandRepository.findByDroneIdOrderByExecutedAtDesc(droneId)
                : commandRepository.findAll();
        return commands.stream()
                .map(FlightCommandResponse::fromEntity)
                .toList();
    }
}

