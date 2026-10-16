package com.droneiq.command.service;

import com.droneiq.command.dto.FlightCommandRequest;
import com.droneiq.command.dto.FlightCommandResponse;
import com.droneiq.command.entity.FlightCommand;
import com.droneiq.command.repository.FlightCommandRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class FlightCommandServiceTest {

    @Mock
    private FlightCommandRepository commandRepository;

    @Mock
    private DroneCommandWebSocketService droneCommandWebSocketService;

    private FlightCommandService flightCommandService;

    @BeforeEach
    void setUp() {
        flightCommandService = new FlightCommandService(
                commandRepository,
                droneCommandWebSocketService,
                new ObjectMapper()
        );
    }

    @Test
    void emergencyLandIsForwardedToBridgeAsLand() {
        when(commandRepository.save(any(FlightCommand.class)))
                .thenAnswer(invocation -> {
                    FlightCommand command = invocation.getArgument(0);
                    command.setId(42L);
                    return command;
                });

        FlightCommandRequest request = new FlightCommandRequest(
                "DRONE-001",
                "EMERGENCY_LAND",
                null,
                Map.of()
        );

        FlightCommandResponse response =
                flightCommandService.executeOverrideCommand(request, "operator");

        verify(droneCommandWebSocketService).sendCommand(
                "DRONE-001",
                "42",
                "LAND",
                Map.of()
        );
        assertEquals("OVERRIDE_PENDING", response.status());
        assertEquals("EMERGENCY_LAND", response.commandType());
    }
}
