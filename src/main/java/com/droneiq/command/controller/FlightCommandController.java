package com.droneiq.command.controller;

import com.droneiq.command.dto.FlightCommandRequest;
import com.droneiq.command.dto.FlightCommandResponse;
import com.droneiq.command.service.FlightCommandService;
import com.droneiq.common.dto.ApiResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/commands")
@Tag(name = "Flight Commands", description = "Flight Command Execution (ARM/Takeoff/RTL/Override)")
@SecurityRequirement(name = "BearerAuth")
public class FlightCommandController {

    private final FlightCommandService commandService;

    public FlightCommandController(FlightCommandService commandService) {
        this.commandService = commandService;
    }

    @PostMapping("/execute")
    @PreAuthorize("hasAuthority('FLIGHT_COMMAND:EXECUTE')")
    @Operation(summary = "Execute routine flight command (Super Admin & Flight Operator/Pilot)")
    public ResponseEntity<ApiResponse<FlightCommandResponse>> executeRoutineCommand(
            @Valid @RequestBody FlightCommandRequest request,
            @AuthenticationPrincipal UserDetails userDetails) {
        FlightCommandResponse response = commandService.executeRoutineCommand(request, userDetails.getUsername());
        return ResponseEntity.ok(ApiResponse.success("Flight command executed successfully", response));
    }

    @PostMapping("/override")
    @PreAuthorize("hasAuthority('FLIGHT_COMMAND:OVERRIDE')")
    @Operation(summary = "Execute emergency override command (Super Admin & Fleet Manager)")
    public ResponseEntity<ApiResponse<FlightCommandResponse>> executeOverrideCommand(
            @Valid @RequestBody FlightCommandRequest request,
            @AuthenticationPrincipal UserDetails userDetails) {
        FlightCommandResponse response = commandService.executeOverrideCommand(request, userDetails.getUsername());
        return ResponseEntity.ok(ApiResponse.success("Override command accepted for dispatch", response));
    }

    @GetMapping("/history")
    @PreAuthorize("hasAuthority('TELEMETRY:VIEW')")
    @Operation(summary = "Query flight command execution history & audit trail (All Roles)")
    public ResponseEntity<ApiResponse<List<FlightCommandResponse>>> getCommandHistory(
            @RequestParam(required = false) String droneId) {
        List<FlightCommandResponse> history = commandService.getCommandHistory(droneId);
        return ResponseEntity.ok(ApiResponse.success(history));
    }
}
