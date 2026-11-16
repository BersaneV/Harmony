# Private proposal. Synthetic decoder validation only; never Harmony capacity.
# Uses only inbox Windows tools and the already-running PowerShell/.NET runtime.
[CmdletBinding()]
param([switch]$SelfTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false


$failureCodes = @(
    'buffers_lost', 'cpu_times_unverified', 'cpu_cycles_unverified', 'dropped_events', 'etl_size_bound', 'event_count_bound', 'events_lost', 'header_fields_invalid', 'header_fields_missing', 'header_missing', 'loss_counter_missing', 'native_tool_nonzero_exit', 'native_tool_output_bound', 'native_tool_start_failed', 'native_tool_timeout', 'none', 'nonfinite_metrics', 'not_started', 'owned_session_cleanup_not_verified', 'owned_windows_runner_required', 'preexisting_wpr_session', 'private_path_already_exists', 'profile_not_verified', 'scheduler_malformed', 'scheduler_schema_missing', 'schema_fixture_failure', 'session_status_unknown', 'sleep_not_exercised', 'synthetic_workload_timeout', 'target_scheduler_missing', 'thread_description_not_verified', 'timestamp_coverage_incomplete', 'timestamp_invalid', 'timestamp_missing', 'timestamp_nonfinite', 'timestamp_regressive', 'timestamp_span_insufficient', 'tools_or_access_unavailable', 'tracerpt_output_missing', 'unexpected_failure', 'worker_cleanup_not_verified', 'workload_duration_unverified', 'xml_size_bound'
)
function New-Timeline {
    return @{ events = 0; valid = 0; missing = 0; invalid = 0; nonfinite = 0; regression = 0; first = $null; previous = $null; last = $null }
}
function Add-TargetTimestamp($Timeline, [AllowNull()][object]$Raw) {
    $Timeline.events++
    if ($null -eq $Raw) { $Timeline.missing++; return }
    if ([string]$Raw -match '^(?i:NaN|[+-]?Infinity|[+-]?Inf)$') { $Timeline.nonfinite++; return }
    [DateTimeOffset]$instant = [DateTimeOffset]::MinValue
    if ($Raw -isnot [string] -or $Raw -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$' -or -not [DateTimeOffset]::TryParse($Raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$instant)) { $Timeline.invalid++; return }
    $ticks = $instant.UtcTicks
    if ($null -ne $Timeline.previous -and $ticks -lt $Timeline.previous) { $Timeline.regression++ }
    if ($null -eq $Timeline.first) { $Timeline.first = $ticks }
    $Timeline.previous = $ticks
    $Timeline.last = $ticks
    $Timeline.valid++
}
function Get-TimelineFailure($Timeline) {
    if ($Timeline.missing -gt 0) { return 'timestamp_missing' }
    if ($Timeline.nonfinite -gt 0) { return 'timestamp_nonfinite' }
    if ($Timeline.invalid -gt 0) { return 'timestamp_invalid' }
    if ($Timeline.regression -gt 0) { return 'timestamp_regressive' }
    if ($Timeline.events -eq 0 -or $Timeline.valid -ne $Timeline.events) { return 'timestamp_coverage_incomplete' }
    return 'none'
}
function Get-TimelineSpan($Timeline) {
    if ((Get-TimelineFailure $Timeline) -ne 'none') { return $null }
    return ($Timeline.last - $Timeline.first) / 10000.0
}
function Get-SessionFailure([int]$QueryExit, [string]$Sessions, [string]$Status) {
    if ($QueryExit -ne 0) { return 'native_tool_nonzero_exit' }
    if ($Sessions -match 'WPR_initiated_' -or $Status -match '(?i)recording is in progress') { return 'preexisting_wpr_session' }
    if ($Status -notmatch '(?i)\bnot recording\b') { return 'session_status_unknown' }
    return 'none'
}
function Get-NativeFailure([bool]$Started, [bool]$TimedOut, [int]$ExitCode) {
    if (-not $Started) { return 'native_tool_start_failed' }
    if ($TimedOut) { return 'native_tool_timeout' }
    if ($ExitCode -ne 0) { return 'native_tool_nonzero_exit' }
    return 'none'
}
function Get-IntegrityFailure($Shape, $EventsLost, $BuffersLost, $Dropped) {
    if ($Shape.log_headers -eq 0) { return 'header_missing' }
    if ($Shape.header_fields_missing -gt 0) { return 'header_fields_missing' }
    if ($Shape.header_fields_invalid -gt 0) { return 'header_fields_invalid' }
    if ($null -eq $EventsLost -or $null -eq $BuffersLost -or $null -eq $Dropped) { return 'loss_counter_missing' }
    if ($EventsLost -gt 0) { return 'events_lost' }
    if ($BuffersLost -gt 0) { return 'buffers_lost' }
    if ($Dropped -gt 0) { return 'dropped_events' }
    return 'none'
}
function Resolve-Failure([string]$Code) {
    if ($Code -cin $failureCodes) { return $Code }
    return 'unexpected_failure'
}
function Test-AdditionalGuards {
    $count = 0
    foreach ($case in @(
        @{ values = @(10000,0,9990); code = 'timestamp_regressive'; regression = 1; missing = 0; invalid = 0; nonfinite = 0; span = $null }
        @{ values = @(0,$null,10000); code = 'timestamp_missing'; regression = 0; missing = 1; invalid = 0; nonfinite = 0; span = $null }
        @{ values = @(0,0,10000); code = 'none'; regression = 0; missing = 0; invalid = 0; nonfinite = 0; span = 10000 }
        @{ values = @(0,'invalid',10000); code = 'timestamp_invalid'; regression = 0; missing = 0; invalid = 1; nonfinite = 0; span = $null }
        @{ values = @(0,'NaN',10000); code = 'timestamp_nonfinite'; regression = 0; missing = 0; invalid = 0; nonfinite = 1; span = $null }
    )) {
        $timeline = New-Timeline
        foreach ($value in $case.values) {
            $raw = if ($value -is [int]) { [DateTimeOffset]::new(2020,1,1,0,0,0,[TimeSpan]::Zero).AddMilliseconds($value).ToString('O') } else { $value }
            Add-TargetTimestamp $timeline $raw
        }
        if ((Get-TimelineFailure $timeline) -cne $case.code -or (Get-TimelineSpan $timeline) -ne $case.span -or $timeline.events -ne 3 -or $timeline.regression -ne $case.regression -or $timeline.missing -ne $case.missing -or $timeline.invalid -ne $case.invalid -or $timeline.nonfinite -ne $case.nonfinite) { throw 'schema_fixture_failure' }
        $count++
    }
    $checks = @(
        (Get-SessionFailure 0 'WPR_initiated_owned' '') -ceq 'preexisting_wpr_session'
        (Get-SessionFailure 0 '' 'unexpected private text') -ceq 'session_status_unknown'
        (Get-SessionFailure 0 '' 'WPR is not recording') -ceq 'none'
        (Get-SessionFailure 7 '' '') -ceq 'native_tool_nonzero_exit'
        (Get-NativeFailure $false $false 0) -ceq 'native_tool_start_failed'
        (Get-NativeFailure $true $true 0) -ceq 'native_tool_timeout'
        (Get-NativeFailure $true $false 7) -ceq 'native_tool_nonzero_exit'
        (Get-NativeFailure $true $false 0) -ceq 'none'
        (Get-IntegrityFailure @{ log_headers=0; header_fields_missing=0; header_fields_invalid=0 } 0 0 0) -ceq 'header_missing'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=1; header_fields_invalid=0 } 0 0 0) -ceq 'header_fields_missing'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=1 } 0 0 0) -ceq 'header_fields_invalid'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=0 } $null 0 0) -ceq 'loss_counter_missing'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=0 } 1 0 0) -ceq 'events_lost'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=0 } 0 1 0) -ceq 'buffers_lost'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=0 } 0 0 1) -ceq 'dropped_events'
        (Get-IntegrityFailure @{ log_headers=1; header_fields_missing=0; header_fields_invalid=0 } 0 0 0) -ceq 'none'
        (Resolve-Failure 'timestamp_regressive') -ceq 'timestamp_regressive'
        (Resolve-Failure 'private text must not be exported') -ceq 'unexpected_failure'
    )
    if ($checks -contains $false) { throw 'schema_fixture_failure' }
    return $count + $checks.Count
}


$schemaFields = @('OldThreadId','NewThreadId','OldThreadState','OldThreadWaitReason','TThreadId','EventsLost','BuffersLost')
$fieldShapeKeys = @('present','missing','duplicate','decimal','hex','whitespace','empty','negative','nonfinite','fractional','exceeds_u32','other','rejected','zero','positive','domain_rejected')
function New-FieldShapes {
    $shapes = @{}
    foreach ($field in $schemaFields) {
        $shapes[$field] = @{}
        foreach ($key in $fieldShapeKeys) { $shapes[$field][$key] = 0 }
    }
    return $shapes
}
function Measure-FieldShapes($Raw, $Counts, [string[]]$Expected, [switch]$HeaderUInt32) {
    $shapes = New-FieldShapes
    foreach ($field in $Expected) {
        $shape = $shapes[$field]
        if (-not $Raw.ContainsKey($field)) { $shape.missing = 1; continue }
        $shape.present = 1; $shape.duplicate = [Math]::Max(0, $Counts[$field] - 1)
        [string]$value = $Raw[$field]
        $trimmed = $value.Trim() # Classification only; parsing still uses unmodified bytes.
        $shape.whitespace = [int]($value -cne $trimmed)
        if ($trimmed.Length -eq 0) { $shape.empty = 1 }
        elseif ($trimmed -match '^(?i:NaN|[+-]?Infinity|[+-]?Inf)$') { $shape.nonfinite = 1 }
        elseif ($trimmed -cmatch '^-[0-9]+$') { $shape.negative = 1 }
        elseif ($trimmed -cmatch '^[0-9]+$') {
            $shape.decimal = 1
            [uint32]$n = 0
            if (-not [uint32]::TryParse($trimmed, [ref]$n)) { $shape.exceeds_u32 = 1 }
        } elseif ($trimmed -cmatch '^0[xX][0-9a-fA-F]+$') {
            $shape.hex = 1
            if ($trimmed.Length -gt 10) { $shape.exceeds_u32 = 1 }
        } elseif ($trimmed -cmatch '^[+-]?[0-9]+\.[0-9]+$') { $shape.fractional = 1 }
        else { $shape.other = 1 }
        $parsed = if ($HeaderUInt32 -and $field -in @('EventsLost','BuffersLost')) { Read-HeaderU32 $value } else { Read-U32 $value }
        $shape.rejected = [int]($null -eq $parsed)
        if ($null -ne $parsed) {
            $shape.zero = [int]($parsed -eq 0); $shape.positive = [int]($parsed -gt 0)
            if (($field -eq 'OldThreadState' -and $parsed -gt 7) -or ($field -eq 'OldThreadWaitReason' -and $parsed -gt 255)) { $shape.domain_rejected = 1 }
        }
    }
    return $shapes
}
function Read-StaticSchemaMetadata {
    # Get-CimClass reads class definitions locally, never instances or remote sessions.
    $out = @{ status='NOT_VERIFIED'; classes_available=0; query_failures=0; fields=@{} }
    $classes = @{ CSwitch=@('OldThreadId','NewThreadId','OldThreadState','OldThreadWaitReason'); ReadyThread=@('TThreadId'); EventTrace_Header=@('EventsLost','BuffersLost') }
    foreach ($name in $classes.Keys) {
        foreach ($field in $classes[$name]) { $out.fields[$field] = 'unknown' }
        try {
            $definition = Get-CimClass -Namespace root/wmi -ClassName $name -OperationTimeoutSec 5 -ErrorAction Stop
            $out.classes_available++
            foreach ($field in $classes[$name]) {
                $property = $definition.CimClassProperties[$field]
                if ($null -ne $property) {
                    $type = $property.CimType.ToString()
                    if ($type -cin @('UInt8','UInt16','UInt32','UInt64','SInt8','SInt16','SInt32','SInt64','String','Boolean')) { $out.fields[$field] = $type }
                }
            }
        } catch { $out.query_failures++ }
    }
    if ($out.classes_available -eq 3 -and $out.query_failures -eq 0 -and -not ($out.fields.Values -contains 'unknown')) { $out.status = 'OBSERVED' }
    return $out
}
function Test-FieldShapes {
    $cases = @(
        @{ raw='0'; key='zero'; rejected=0 }
        @{ raw='1'; key='positive'; rejected=0 }
        @{ raw='0x2a'; key='hex'; rejected=0 }
        @{ raw=' 0 '; key='whitespace'; rejected=1 }
        @{ raw='-1'; key='negative'; rejected=1 }
        @{ raw='4294967296'; key='exceeds_u32'; rejected=1 }
        @{ raw='0x100000000'; key='exceeds_u32'; rejected=1 }
        @{ raw='NaN'; key='nonfinite'; rejected=1 }
        @{ raw='1.5'; key='fractional'; rejected=1 }
        @{ raw=''; key='empty'; rejected=1 }
        @{ raw='unrecognized'; key='other'; rejected=1 }
    )
    foreach ($case in $cases) {
        $shape = (Measure-FieldShapes @{ EventsLost=$case.raw } @{ EventsLost=1 } @('EventsLost')).EventsLost
        if ($shape[$case.key] -ne 1 -or $shape.rejected -ne $case.rejected) { throw 'schema_fixture_failure' }
    }
    if ((Measure-FieldShapes @{} @{} @('EventsLost')).EventsLost.missing -ne 1) { throw 'schema_fixture_failure' }
    if ((Measure-FieldShapes @{ EventsLost='0' } @{ EventsLost=2 } @('EventsLost')).EventsLost.duplicate -ne 1) { throw 'schema_fixture_failure' }
    if ((Measure-FieldShapes @{ OldThreadState='8' } @{ OldThreadState=1 } @('OldThreadState')).OldThreadState.domain_rejected -ne 1) { throw 'schema_fixture_failure' }
    return $cases.Count + 3
}

function Read-U32([string]$Value) {
    [uint32]$n = 0
    if ($Value -cmatch '^0[xX][0-9a-fA-F]{1,8}$') {
        return [Convert]::ToUInt32($Value.Substring(2), 16)
    }
    if ($Value -cmatch '^[0-9]{1,10}$' -and [uint32]::TryParse($Value, [ref]$n)) { return $n }
    return $null
}

function Read-HeaderU32([string]$Value) {
    # XML S whitespace only. Do not use Unicode Trim(), aliases, defaults or ID parsing.
    return Read-U32 ($Value.Trim([char[]]@([char]0x20,[char]0x09,[char]0x0A,[char]0x0D)))
}
function Test-HeaderWhitespace {
    $pad = " `t`r`n"
    $nbsp = [string][char]0xA0
    $em = [string][char]0x2003
    $vertical = [string][char]0x0B
    $header = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Guid="{68fdd900-4a3e-11d1-84f4-0000f80464e3}"/><Opcode>0</Opcode></System><EventData><Data Name="EventsLost"> 0 </Data><Data Name="BuffersLost"> 7 </Data></EventData></Event>'
    $idEvent = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Guid="{3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c}"/><Opcode>36</Opcode></System><EventData><Data Name="OldThreadId"> 42 </Data><Data Name="NewThreadId">9</Data><Data Name="OldThreadState">5</Data><Data Name="OldThreadWaitReason">4</Data></EventData></Event>'
    $checks = @(
        (Read-HeaderU32 ($pad + '0' + $pad)) -eq 0
        (Read-HeaderU32 ($pad + '7' + $pad)) -eq 7
        (Read-HeaderU32 ($pad + '4294967295' + $pad)) -eq [uint32]::MaxValue
        $null -eq (Read-HeaderU32 ($pad + '4294967296' + $pad))
        $null -eq (Read-HeaderU32 ($pad + '-1' + $pad))
        $null -eq (Read-HeaderU32 $pad)
        $null -eq (Read-HeaderU32 ($nbsp + '0' + $nbsp))
        $null -eq (Read-HeaderU32 ($em + '0' + $em))
        $null -eq (Read-HeaderU32 ($vertical + '0' + $vertical))
        ((Decode-Event ([xml]$header) 42).events_lost -eq 0 -and (Decode-Event ([xml]$header) 42).buffers_lost -eq 7)
        ((Decode-Event ([xml]($header.Replace('</EventData>','<Data Name="EventsLost">0</Data></EventData>'))) 42).shape.header_fields_invalid -eq 1 -and $null -eq (Decode-Event ([xml]($header.Replace('</EventData>','<Data Name="EventsLost">0</Data></EventData>'))) 42).events_lost)
        ((Decode-Event ([xml]($header.Replace('<Data Name="BuffersLost"> 7 </Data>',''))) 42).shape.header_fields_missing -eq 1 -and $null -eq (Decode-Event ([xml]($header.Replace('<Data Name="BuffersLost"> 7 </Data>',''))) 42).buffers_lost)
        $null -eq (Read-U32 ' 0 ')
        -not (Decode-Event ([xml]$idEvent) 42).valid
        $null -eq (Decode-Event ([xml]($header.Replace('68fdd900','00000000'))) 42).events_lost
        (Measure-FieldShapes @{ OldThreadId=' 42 ' } @{ OldThreadId=1 } @('OldThreadId') -HeaderUInt32).OldThreadId.rejected -eq 1
        (Measure-FieldShapes @{ EventsLost=' 0 ' } @{ EventsLost=1 } @('EventsLost') -HeaderUInt32).EventsLost.rejected -eq 0
        (Measure-FieldShapes @{ EventsLost=($nbsp+'0'+$nbsp) } @{ EventsLost=1 } @('EventsLost') -HeaderUInt32).EventsLost.rejected -eq 1
    )
    if ($checks -contains $false) { throw 'schema_fixture_failure' }
    return $checks.Count
}

function Decode-Event([xml]$Record, [uint32]$Target) {
    $out = @{ kind = 'other'; valid = $false; incoming = $false; outgoing = $false; ready = $false; wait_reason = $null; events_lost = $null; buffers_lost = $null; field_shapes = (New-FieldShapes); shape = @{ provider_guid=0; extended_guid=0; opcode=0; named_fields=0; direct_fields=0; thread_headers=0; log_headers=0; header_fields_missing=0; header_fields_invalid=0 } }
    $data = @{}; $duplicate = $false; $rawFields = @{}; $fieldCounts = @{}
    $out.shape.provider_guid = [int]($Record.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Provider"]/@Guid').Count -gt 0)
    $out.shape.extended_guid = [int]($Record.SelectNodes('/*[local-name()="Event"]/*[local-name()="ExtendedTracingInfo"]/*[local-name()="EventGuid"]').Count -gt 0)
    foreach ($node in $Record.SelectNodes('/*[local-name()="Event"]/*[local-name()="EventData"]/*')) {
        if ($node.LocalName -eq 'Data') { $out.shape.named_fields = 1 } else { $out.shape.direct_fields = 1 }
        $name = if ($node.LocalName -eq 'Data') { $node.GetAttribute('Name') } else { $node.LocalName }
        if ($name -notin @('OldThreadId','NewThreadId','OldThreadState','OldThreadWaitReason','TThreadId','EventsLost','BuffersLost')) { continue }
        if (-not $fieldCounts.ContainsKey($name)) { $fieldCounts[$name] = 0 }
        $fieldCounts[$name]++
        if (-not $rawFields.ContainsKey($name)) { $rawFields[$name] = $node.InnerText }
        if ($data.ContainsKey($name)) { $duplicate = $true; continue }
        $data[$name] = Read-U32 $node.InnerText
    }
    $providers = $Record.SelectNodes('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Provider"]/@Guid | /*[local-name()="Event"]/*[local-name()="ExtendedTracingInfo"]/*[local-name()="EventGuid"]')
    $isThread = $false; $isHeader = $false
    foreach ($node in $providers) {
        $guid = if ($node -is [Xml.XmlAttribute]) { $node.Value } else { $node.InnerText }
        if ($guid.Trim('{}') -ieq '3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c') { $isThread = $true }
        if ($guid.Trim('{}') -ieq '68fdd900-4a3e-11d1-84f4-0000f80464e3') { $isHeader = $true }
    }
    $opcode = $Record.SelectSingleNode('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="Opcode"]')
    if ($null -eq $opcode) { return $out }
    $out.shape.opcode = 1
    $op = Read-U32 $opcode.InnerText
    if ($isHeader -and $op -eq 0 -and -not $duplicate) {
        foreach ($field in @('EventsLost','BuffersLost')) {
            if ($rawFields.ContainsKey($field)) { $data[$field] = Read-HeaderU32 $rawFields[$field] }
        }
    }
    $expectedFields = @()
    if ($isHeader -and $op -eq 0) { $expectedFields = @('EventsLost','BuffersLost') }
    elseif ($isThread -and $op -eq 36) { $expectedFields = @('OldThreadId','NewThreadId','OldThreadState','OldThreadWaitReason') }
    elseif ($isThread -and $op -eq 50) { $expectedFields = @('TThreadId') }
    $out.field_shapes = Measure-FieldShapes $rawFields $fieldCounts $expectedFields -HeaderUInt32:($isHeader -and $op -eq 0)
    if ($isThread -and $op -in @(36,50)) { $out.shape.thread_headers = 1 }
    if ($isHeader -and $op -eq 0) {
        $out.shape.log_headers = 1
        if (-not $data.ContainsKey('EventsLost') -or -not $data.ContainsKey('BuffersLost')) { $out.shape.header_fields_missing = 1 }
        elseif ($duplicate -or $null -eq $data.EventsLost -or $null -eq $data.BuffersLost) { $out.shape.header_fields_invalid = 1 }
    }
    if ($isHeader -and $op -eq 0 -and -not $duplicate) {
        if ($data.ContainsKey('EventsLost')) { $out.events_lost = $data.EventsLost }
        if ($data.ContainsKey('BuffersLost')) { $out.buffers_lost = $data.BuffersLost }
    }
    if (-not $isThread) { return $out }
    if ($op -eq 36) {
        $out.kind = 'cswitch'
        if ($duplicate) { return $out }
        if ($data.ContainsKey('OldThreadId') -and $data.ContainsKey('NewThreadId') -and $data.ContainsKey('OldThreadState') -and $data.ContainsKey('OldThreadWaitReason') -and $null -ne $data.OldThreadId -and $null -ne $data.NewThreadId -and $null -ne $data.OldThreadState -and $data.OldThreadState -le 7 -and $null -ne $data.OldThreadWaitReason -and $data.OldThreadWaitReason -le 255) {
            $out.valid = $true
            $out.incoming = $data.NewThreadId -eq $Target
            $out.outgoing = $data.OldThreadId -eq $Target
            if ($out.outgoing -and $data.OldThreadState -eq 5) { $out.wait_reason = $data.OldThreadWaitReason }
        }
    } elseif ($op -eq 50) {
        $out.kind = 'readythread'
        if ($duplicate) { return $out }
        if ($data.ContainsKey('TThreadId') -and $null -ne $data.TThreadId) {
            $out.valid = $true
            $out.ready = $data.TThreadId -eq $Target
        }
    }
    return $out
}
function Test-Decoder {
    $prefix = '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Guid="{3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c}"/><Opcode>'
    $suffix = '</EventData></Event>'
    $cs = $prefix + '36</Opcode></System><EventData><Data Name="OldThreadId">0x2a</Data><Data Name="NewThreadId">9</Data><Data Name="OldThreadState">5</Data><Data Name="OldThreadWaitReason">4</Data>' + $suffix
    $rt = $prefix + '50</Opcode></System><EventData><Data Name="TThreadId">42</Data>' + $suffix
    $header = $prefix.Replace('3d6fa8d1-fe05-11d0-9dda-00c04fd7ba7c','68fdd900-4a3e-11d1-84f4-0000f80464e3') + '0</Opcode></System><EventData><Data Name="EventsLost">0</Data><Data Name="BuffersLost">0</Data>' + $suffix
    $checks = @(
        (Decode-Event ([xml]$header) 42).events_lost -eq 0
        (Decode-Event ([xml]$header) 42).buffers_lost -eq 0
        $null -eq (Decode-Event ([xml]($header.Replace('68fdd900','00000000'))) 42).events_lost
        $null -eq (Decode-Event ([xml]($header.Replace('>0</Data>','>false</Data>'))) 42).events_lost
        (Read-U32 '4294967295') -eq [uint32]::MaxValue
        $null -eq (Read-U32 '4294967296')
        $null -eq (Read-U32 '-1')
        $null -eq (Read-U32 '1.5')
        $null -eq (Read-U32 'true')
        (Decode-Event ([xml]$cs) 42).outgoing
        (Decode-Event ([xml]$cs) 42).wait_reason -eq 4
        (Decode-Event ([xml]$rt) 42).ready
        -not (Decode-Event ([xml]$rt) 43).ready
        -not (Decode-Event ([xml]($cs.Replace('NewThreadId','MissingField'))) 42).valid
        -not (Decode-Event ([xml]($rt.Replace('3d6fa8d1','00000000'))) 42).valid
        -not (Decode-Event ([xml]($rt.Replace('42</Data>','-1</Data>'))) 42).valid
        -not (Decode-Event ([xml]($rt.Replace('</EventData>','<Data Name="TThreadId">42</Data></EventData>'))) 42).valid
        (Decode-Event ([xml]($rt.Replace('<Data Name="TThreadId">42</Data>','<TThreadId>42</TThreadId>'))) 42).ready
    )
    if ($checks -contains $false) { throw 'schema_fixture_failure' }
    return $checks.Count
}
function Invoke-Inbox([string]$Tool, [string[]]$Arguments, [int]$Seconds = 30) {
    $class = switch ([IO.Path]::GetFileName($Tool).ToLowerInvariant()) { 'wpr.exe' { 'wpr' }; 'tracerpt.exe' { 'tracerpt' }; 'logman.exe' { 'logman' }; default { throw 'unexpected_failure' } }
    $report.last_native_tool = $class
    $outcome = $report.native_tool_results[$class]
    $outcome.calls++; $outcome.last_exit_code = $null; $outcome.last_timed_out = $false
    $start = [Diagnostics.ProcessStartInfo]::new($Tool)
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in $Arguments) { $start.ArgumentList.Add($arg) }
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    try {
        try { $started = $child.Start() } catch { $outcome.start_failures++; throw 'native_tool_start_failed' }
        if (-not $started) { $outcome.start_failures++; throw (Get-NativeFailure $false $false 0) }
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit($Seconds * 1000)) {
            $outcome.timeouts++; $outcome.last_timed_out = $true
            try { $child.Kill($true); [void]$child.WaitForExit(5000) } catch { }
            throw (Get-NativeFailure $true $true 0)
        }
        $outcome.last_exit_code = $child.ExitCode
        if ($child.ExitCode -ne 0) { $outcome.last_nonzero_exit_code = $child.ExitCode }
        $text = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
        if ($text.Length -gt 1048576) { throw 'native_tool_output_bound' }
        return @{ code = $child.ExitCode; text = $text }
    } finally { $child.Dispose() }
}


try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public sealed class SchedulingFault:Exception { public readonly string Code; public readonly int? NativeCode,VisibleCandidates,TitleMatches; public SchedulingFault(string code,int? native=null,int? visible=null,int? matches=null):base(code){Code=code;NativeCode=native;VisibleCandidates=visible;TitleMatches=matches;} }
public sealed class QueryHandle:SafeHandleZeroOrMinusOneIsInvalid { public QueryHandle():base(true){} [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); protected override bool ReleaseHandle(){return CloseHandle(handle);} }
public static class SchedulerNative {
 [StructLayout(LayoutKind.Sequential)] public struct FT {public uint Low,High; public ulong Value(){return ((ulong)High<<32)|Low;}}
 [DllImport("kernel32.dll",SetLastError=true)] public static extern QueryHandle OpenProcess(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetProcessIdOfThread(QueryHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern QueryHandle OpenThread(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(QueryHandle h,uint flags,StringBuilder name,ref uint count);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(QueryHandle h,out FT c,out FT e,out FT k,out FT u);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(QueryHandle h,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeThread(QueryHandle h,out uint code);
 [DllImport("kernel32.dll",EntryPoint="GetThreadTimes",SetLastError=true)] public static extern bool Times(QueryHandle h,out FT c,out FT e,out FT k,out FT u);
 [DllImport("kernel32.dll",EntryPoint="GetThreadTimes",SetLastError=true)] public static extern bool LongTimes(QueryHandle h,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool QueryThreadCycleTime(QueryHandle h,out ulong cycles);
 [DllImport("kernel32.dll")] static extern int GetThreadDescription(QueryHandle h,out IntPtr name);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out FT time);
 delegate bool EnumWindowsCallback(IntPtr w,IntPtr p);
 [DllImport("user32.dll",SetLastError=true)] static extern bool EnumWindows(EnumWindowsCallback cb,IntPtr p);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern int GetWindowText(IntPtr w,StringBuilder text,int count);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 public static string Image(QueryHandle h){var b=new StringBuilder(32768);uint n=32768;if(!QueryFullProcessImageName(h,0,b,ref n))throw new SchedulingFault("process_query_failed",Marshal.GetLastWin32Error());return Path.GetFullPath(b.ToString());}
 public static ulong Creation(QueryHandle h,bool process){FT c,e,k,u;bool ok=process?GetProcessTimes(h,out c,out e,out k,out u):Times(h,out c,out e,out k,out u);if(!ok)throw new SchedulingFault("creation_query_failed",Marshal.GetLastWin32Error());return c.Value();}
 public static bool Alive(QueryHandle h,bool process){uint c;bool ok=process?GetExitCodeProcess(h,out c):GetExitCodeThread(h,out c);return ok&&c==259;}
 public static string Description(QueryHandle h){IntPtr p=IntPtr.Zero;int hr=GetThreadDescription(h,out p);try{if(hr<0)throw new SchedulingFault("description_query_failed",hr);return Marshal.PtrToStringUni(p)??"";}finally{if(p!=IntPtr.Zero)LocalFree(p);}}
 public static List<IntPtr> Windows(uint pid,out int visible){var a=new List<IntPtr>();int candidates=0;const string title="Harmony";if(!EnumWindows((w,p)=>{uint owner;GetWindowThreadProcessId(w,out owner);if(owner==pid&&IsWindowVisible(w)){candidates++;var text=new StringBuilder(title.Length+2);int length=GetWindowText(w,text,text.Capacity);if(length==title.Length&&String.Equals(text.ToString(),title,StringComparison.Ordinal))a.Add(w);}return true;},IntPtr.Zero))throw new SchedulingFault("window_query_failed",Marshal.GetLastWin32Error());visible=candidates;return a;}
 public static uint WindowOwner(IntPtr w,uint pid){uint owner;uint id=GetWindowThreadProcessId(w,out owner);if(owner!=pid||id==0)throw new SchedulingFault("window_owner_changed");return id;}
 public sealed class Clock {public readonly long UtcTicks,QpcBefore,Qpc;public Clock(){QpcBefore=Stopwatch.GetTimestamp();FT t;GetSystemTimePreciseAsFileTime(out t);UtcTicks=DateTime.FromFileTimeUtc((long)t.Value()).Ticks;Qpc=Stopwatch.GetTimestamp();}public Dictionary<string,object> Export(){return new Dictionary<string,object>{{"utc_ms",(UtcTicks-621355968000000000L)/10000},{"qpc_ticks",Qpc},{"qpc_frequency",Stopwatch.Frequency},{"clock_query_ms",(Qpc-QpcBefore)*1000.0/Stopwatch.Frequency}};}}
 public static Clock Now(){return new Clock();}
 public sealed class Sample {
  public readonly bool CanonicalOk,LegacyOk,CycleOk; public readonly int? CanonicalError,LegacyError,CycleError; public readonly ulong Kernel,User,Cycles; public readonly long LegacyKernel,LegacyUser;
  public readonly long CanonicalBefore,CanonicalAfter,LegacyBefore,LegacyAfter,CycleBefore,CycleAfter;
  public Sample(QueryHandle h){FT c,e,k,u;long lc,le,lk,lu;ulong cycles;
   LegacyBefore=Stopwatch.GetTimestamp();LegacyOk=LongTimes(h,out lc,out le,out lk,out lu);if(!LegacyOk)LegacyError=Marshal.GetLastWin32Error();LegacyAfter=Stopwatch.GetTimestamp();LegacyKernel=lk;LegacyUser=lu;
   CanonicalBefore=Stopwatch.GetTimestamp();CanonicalOk=Times(h,out c,out e,out k,out u);if(!CanonicalOk)CanonicalError=Marshal.GetLastWin32Error();CanonicalAfter=Stopwatch.GetTimestamp();Kernel=k.Value();User=u.Value();
   CycleBefore=Stopwatch.GetTimestamp();CycleOk=QueryThreadCycleTime(h,out cycles);if(!CycleOk)CycleError=Marshal.GetLastWin32Error();CycleAfter=Stopwatch.GetTimestamp();Cycles=cycles;
  }
  public Dictionary<string,object> Export(){return new Dictionary<string,object>{{"canonical_ok",CanonicalOk},{"legacy_ok",LegacyOk},{"cycles_ok",CycleOk},{"canonical_error",CanonicalError},{"legacy_error",LegacyError},{"cycle_error",CycleError},{"kernel_100ns",CanonicalOk?(object)Kernel:null},{"user_100ns",CanonicalOk?(object)User:null},{"legacy_kernel_100ns",LegacyOk?(object)LegacyKernel:null},{"legacy_user_100ns",LegacyOk?(object)LegacyUser:null},{"cycles",CycleOk?(object)Cycles:null},{"canonical_before_qpc_ticks",CanonicalBefore},{"canonical_after_qpc_ticks",CanonicalAfter},{"legacy_before_qpc_ticks",LegacyBefore},{"legacy_after_qpc_ticks",LegacyAfter},{"cycles_before_qpc_ticks",CycleBefore},{"cycles_after_qpc_ticks",CycleAfter}};}
 }
 public static Dictionary<string,object> Delta(Sample a,Sample b){bool canonical=a.CanonicalOk&&b.CanonicalOk&&b.Kernel>=a.Kernel&&b.User>=a.User,legacy=a.LegacyOk&&b.LegacyOk&&a.LegacyKernel>=0&&a.LegacyUser>=0&&b.LegacyKernel>=a.LegacyKernel&&b.LegacyUser>=a.LegacyUser,cycle=a.CycleOk&&b.CycleOk&&b.Cycles>=a.Cycles;double? k=canonical?(double?)(b.Kernel-a.Kernel)/10000:null,u=canonical?(double?)(b.User-a.User)/10000:null,lk=legacy?(double?)(b.LegacyKernel-a.LegacyKernel)/10000:null,lu=legacy?(double?)(b.LegacyUser-a.LegacyUser)/10000:null;bool ok=canonical&&legacy&&cycle;string amount=!ok?"cpu_queries_unverified":k+u==0?"counter_zero_ambiguous":k!=lk||u!=lu?"query_windows_differ":"none";
  return new Dictionary<string,object>{{"status",ok?"OBSERVED":"NOT_VERIFIED"},{"failure_code",ok?"none":"cpu_queries_unverified"},{"start",a.Export()},{"end",b.Export()},{"canonical_monotonic",canonical},{"legacy_monotonic",legacy},{"cycles_monotonic",cycle},{"kernel_ms",k},{"user_ms",u},{"legacy_kernel_ms",lk},{"legacy_user_ms",lu},{"cycles_delta",cycle?(object)(b.Cycles-a.Cycles):null},{"query_span_min_ms",(b.CanonicalBefore-a.CanonicalAfter)*1000.0/Stopwatch.Frequency},{"query_span_max_ms",(b.CanonicalAfter-a.CanonicalBefore)*1000.0/Stopwatch.Frequency},{"amount",new Dictionary<string,object>{{"status",amount=="none"?"OBSERVED":"NOT_VERIFIED"},{"failure_code",amount}}}};
 }
}
public sealed class SchedulingOwner:IDisposable {
 const string Hash="6a1517c44ed45c996ac8d32c08767ea7306e897a4cb73d703d9286b68c86c2cc";
 public int IdentityVisibleCandidates {get;private set;} public int IdentityTitleMatches {get;private set;}
 readonly string path; readonly uint pid,uiId,captureId; readonly ulong processCreated,uiCreated,captureCreated; readonly IntPtr window; readonly QueryHandle process,ui,capture;
 public SchedulingOwner(string exe,string root,string temp){path=Path.GetFullPath(exe);string r=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,t=Path.GetFullPath(temp).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;if(!r.StartsWith(t,StringComparison.OrdinalIgnoreCase)||!path.StartsWith(r,StringComparison.OrdinalIgnoreCase))throw new SchedulingFault("installed_path_unverified");using(var f=File.Open(path,FileMode.Open,FileAccess.Read,FileShare.Read)){if(Convert.ToHexString(SHA256.HashData(f)).ToLowerInvariant()!=Hash)throw new SchedulingFault("main_hash_mismatch");}
  Process[] candidates=Process.GetProcessesByName(Path.GetFileNameWithoutExtension(path));try{if(candidates.Length!=1)throw new SchedulingFault("process_not_unique");pid=(uint)candidates[0].Id;}finally{foreach(var p in candidates)p.Dispose();}
  try{process=SchedulerNative.OpenProcess(0x1000,false,pid);if(process.IsInvalid||!SchedulerNative.Alive(process,true)||!String.Equals(SchedulerNative.Image(process),path,StringComparison.OrdinalIgnoreCase))throw new SchedulingFault("process_identity_unverified");processCreated=SchedulerNative.Creation(process,true);
   int visible;var windows=SchedulerNative.Windows(pid,out visible);IdentityVisibleCandidates=visible;IdentityTitleMatches=windows.Count;if(windows.Count!=1)throw new SchedulingFault("window_not_unique",null,visible,windows.Count);window=windows[0];uiId=SchedulerNative.WindowOwner(window,pid);captureId=FindCapture();if(uiId==captureId)throw new SchedulingFault("roles_not_distinct");
   ui=SchedulerNative.OpenThread(0x0800,false,uiId);capture=SchedulerNative.OpenThread(0x0800,false,captureId);if(ui.IsInvalid||capture.IsInvalid||SchedulerNative.GetProcessIdOfThread(ui)!=pid||SchedulerNative.GetProcessIdOfThread(capture)!=pid)throw new SchedulingFault("thread_open_failed");uiCreated=SchedulerNative.Creation(ui,false);captureCreated=SchedulerNative.Creation(capture,false);Validate();
  }catch{Dispose();throw;}
 }
 uint FindCapture(){uint found=0;int matches=0;using(var p=Process.GetProcessById((int)pid)){foreach(ProcessThread t in p.Threads){try{using(var h=SchedulerNative.OpenThread(0x0800,false,(uint)t.Id)){if(h.IsInvalid)throw new SchedulingFault("thread_enumeration_unverified");if(SchedulerNative.Description(h)=="harmony-capture"){found=(uint)t.Id;matches++;}}}finally{t.Dispose();}}}if(matches!=1)throw new SchedulingFault("capture_description_not_unique");return found;}
 public uint RoleId(string role){return role=="capture"?captureId:role=="ui"?uiId:throw new SchedulingFault("role_invalid");}
 public void Validate(){if(process==null||process.IsInvalid||!SchedulerNative.Alive(process,true)||SchedulerNative.Creation(process,true)!=processCreated||!String.Equals(SchedulerNative.Image(process),path,StringComparison.OrdinalIgnoreCase))throw new SchedulingFault("process_changed");int visible;var ws=SchedulerNative.Windows(pid,out visible);IdentityVisibleCandidates=visible;IdentityTitleMatches=ws.Count;if(ws.Count!=1||ws[0]!=window||SchedulerNative.WindowOwner(window,pid)!=uiId||FindCapture()!=captureId)throw new SchedulingFault("subject_changed",null,visible,ws.Count);if(SchedulerNative.GetProcessIdOfThread(ui)!=pid||SchedulerNative.GetProcessIdOfThread(capture)!=pid||!SchedulerNative.Alive(ui,false)||!SchedulerNative.Alive(capture,false)||SchedulerNative.Creation(ui,false)!=uiCreated||SchedulerNative.Creation(capture,false)!=captureCreated||SchedulerNative.Description(capture)!="harmony-capture")throw new SchedulingFault("thread_changed");}
 public SchedulerNative.Sample Read(string role){return new SchedulerNative.Sample(role=="capture"?capture:role=="ui"?ui:throw new SchedulingFault("role_invalid"));}
 public void Dispose(){capture?.Dispose();ui?.Dispose();process?.Dispose();}
}
public sealed class SchedulerLedger {
 enum State{Unknown,Running,Ready,Wait}
 readonly uint target; readonly long begin,end; State state=State.Unknown;long since,last=long.MinValue,first=long.MaxValue;int reason;bool badTime,finished;long running,ready,waiting,delay,userWait,otherWait;int events,windowEvents,regress,errors,unsupported,redundant,overflow,boundaryIntervals,unclassifiedIntervals,missing,invalid,nonfinite;string timeFailure="none";readonly Dictionary<string,int> reasons=new Dictionary<string,int>();readonly List<long> runningSamples=new List<long>(),readySamples=new List<long>(),waitSamples=new List<long>();
 public SchedulerLedger(uint role,long start,long stop){if(role==0||stop<=start)throw new ArgumentException();target=role;begin=start;end=stop;since=start;}
 void AddSample(List<long> list,long ticks){if(list.Count>=32768){overflow++;return;}list.Add(ticks);}
 void Segment(long at,bool forceUnknown=false){long a=Math.Max(since,begin),b=Math.Min(at,end);if(b<=a)return;
  if(forceUnknown||state==State.Unknown){unclassifiedIntervals++;return;}
  if(since<begin||at>end){boundaryIntervals++;return;}
  long d=at-since;
  if(state==State.Running){running+=d;AddSample(runningSamples,d);}else if(state==State.Ready){ready+=d;AddSample(readySamples,d);}else if(state==State.Wait){waiting+=d;AddSample(waitSamples,d);if(reason==4||reason==11)delay+=d;else if(reason==6||reason==13)userWait+=d;else otherWait+=d;}
 }
 bool Touch(long at){if(finished)throw new InvalidOperationException();events++;if(at>=begin&&at<=end)windowEvents++;if(at<last){regress++;badTime=true;if(timeFailure=="none")timeFailure="timestamp_regressive";return false;}if(at<first)first=at;last=at;return !badTime;}
 public void InvalidTimestamp(string code){badTime=true;if(code=="timestamp_missing")missing++;else if(code=="timestamp_nonfinite")nonfinite++;else{invalid++;code="timestamp_invalid";}if(timeFailure=="none")timeFailure=code;}
 public void Switch(long at,uint oldId,uint newId,int oldState,int waitReason){if(oldId!=target&&newId!=target)return;if(!Touch(at))return;if(oldId==target&&newId==target){errors++;Segment(at,true);state=State.Unknown;since=at;return;}
  if(oldId==target){bool conflict=state!=State.Running&&state!=State.Unknown;if(conflict)errors++;Segment(at,conflict);since=at;if(oldState==5){state=State.Wait;reason=waitReason;string key=reason.ToString(System.Globalization.CultureInfo.InvariantCulture);if(at>=begin&&at<=end){if(!reasons.ContainsKey(key))reasons[key]=0;reasons[key]++;}if(reason<0||reason>37)unsupported++;}else if(oldState==1)state=State.Ready;else{state=State.Unknown;unsupported++;}}
  if(newId==target){bool conflict=state!=State.Ready&&state!=State.Unknown;if(conflict)errors++;Segment(at,conflict);state=State.Running;since=at;}
 }
 public void Ready(long at,uint id){if(id!=target)return;if(!Touch(at))return;if(state==State.Ready){redundant++;return;}bool conflict=state==State.Running;if(conflict)errors++;Segment(at,conflict);state=State.Ready;since=at;}
 static Dictionary<string,object> Distribution(List<long> values,bool valid){if(values.Count==0||!valid)return new Dictionary<string,object>{{"samples",values.Count},{"min_ms",null},{"p50_ms",null},{"p95_ms",null},{"max_ms",null},{"mean_ms",null}};var a=values.ToArray();Array.Sort(a);double sum=0;foreach(long n in a)sum+=n;return new Dictionary<string,object>{{"samples",a.Length},{"min_ms",a[0]/10000.0},{"p50_ms",a[(a.Length-1)/2]/10000.0},{"p95_ms",a[(int)Math.Floor((a.Length-1)*.95)]/10000.0},{"max_ms",a[a.Length-1]/10000.0},{"mean_ms",sum/a.Length/10000.0}};}
 public Dictionary<string,object> Finish(){if(!finished){finished=true;}long total=end-begin;string code=badTime?timeFailure:events==0?"target_events_missing":first>begin?"left_boundary_unknown":last<end?"right_boundary_unknown":errors>0?"state_transition_unknown":unsupported>0?"state_unsupported":overflow>0?"distribution_bound":running+ready+waiting!=total?"partial_interval_coverage":"none";bool usable=!badTime;
  return new Dictionary<string,object>{{"status",code=="none"?"OBSERVED":"NOT_VERIFIED"},{"failure_code",code},{"events",events},{"window_events",windowEvents},{"boundary_intervals",boundaryIntervals},{"unclassified_intervals",unclassifiedIntervals},{"regressions",regress},{"timestamps_missing",missing},{"timestamps_invalid",invalid},{"timestamps_nonfinite",nonfinite},{"transition_errors",errors},{"unsupported",unsupported},{"redundant_ready",redundant},{"distribution_overflow",overflow},{"window_ms",total/10000.0},{"running_ms",usable?(object)(running/10000.0):null},{"ready_ms",usable?(object)(ready/10000.0):null},{"wait_ms",usable?(object)(waiting/10000.0):null},{"covered_ms",usable?(object)((running+ready+waiting)/10000.0):null},{"unknown_ms",usable?(object)((total-running-ready-waiting)/10000.0):total/10000.0},{"wait_delay_execution_ms",usable?(object)(delay/10000.0):null},{"wait_user_request_ms",usable?(object)(userWait/10000.0):null},{"wait_other_ms",usable?(object)(otherWait/10000.0):null},{"wait_reason_counts",reasons},{"running_intervals",Distribution(runningSamples,usable&&overflow==0)},{"ready_intervals",Distribution(readySamples,usable&&overflow==0)},{"wait_intervals",Distribution(waitSamples,usable&&overflow==0)}};
 }
}
public static class SchedulingInput {
 public static Task<string> Read(){return Task.Run(()=>{var b=new StringBuilder();for(int i=0;i<=65536;i++){int c=Console.In.Read();if(c<0){if(b.Length==0)return null;throw new SchedulingFault("input_incomplete");}if(c==10)return b.ToString();if(c>127||i==65536)throw new SchedulingFault("input_bound");b.Append((char)c);}throw new SchedulingFault("input_bound");});}
}
public static class SchedulerLedgerTests {
 static long T(int ms){return ms*10000L;}
 static void Check(bool value){if(!value)throw new InvalidOperationException("ledger_fixture_failure");}
 static double N(Dictionary<string,object> d,string key){return Convert.ToDouble(d[key]);}
 static SchedulerLedger Base(bool repeat=false){var x=new SchedulerLedger(7,T(10),T(110));x.Ready(T(0),7);x.Switch(T(20),9,7,5,4);x.Switch(T(50),7,9,5,4);x.Ready(T(80),7);if(repeat)x.Ready(T(85),7);x.Switch(T(90),9,7,5,4);x.Switch(T(120),7,9,5,4);return x;}
 public static int Run(){int tests=0;
  var a=Base().Finish();Check((string)a["status"]=="NOT_VERIFIED"&&N(a,"running_ms")==30&&N(a,"ready_ms")==10&&N(a,"wait_ms")==30&&N(a,"covered_ms")==70&&N(a,"unknown_ms")==30&&N(a,"boundary_intervals")==2);tests++;
  var b=new SchedulerLedger(7,T(0),T(100));b.Ready(T(-10),7);b.Switch(T(0),9,7,5,4);b.Switch(T(40),7,9,5,4);b.Ready(T(70),7);b.Switch(T(80),9,7,5,4);b.Switch(T(100),7,9,5,4);var bx=b.Finish();Check((string)bx["status"]=="OBSERVED"&&N(bx,"running_ms")==60&&N(bx,"ready_ms")==10&&N(bx,"wait_ms")==30&&N(bx,"unknown_ms")==0);tests++;
  var c=new SchedulerLedger(7,T(0),T(100));c.Switch(T(20),9,7,5,4);c.Switch(T(50),7,9,5,4);var cx=c.Finish();Check(N(cx,"running_ms")==30&&N(cx,"wait_ms")==0&&N(cx,"unknown_ms")==70&&(string)cx["failure_code"]=="left_boundary_unknown");tests++;
  var r=Base(true).Finish();Check(N(r,"ready_ms")==10&&N(r,"redundant_ready")==1);tests++;
  var d=Base();d.Ready(T(119),7);var dx=d.Finish();Check((string)dx["failure_code"]=="timestamp_regressive"&&dx["running_ms"]==null&&N(dx,"unknown_ms")==100);tests++;
  var e=Base();e.InvalidTimestamp("timestamp_missing");var ex=e.Finish();Check((string)ex["failure_code"]=="timestamp_missing"&&N(ex,"timestamps_missing")==1&&ex["ready_ms"]==null);tests++;
  var f=new SchedulerLedger(7,T(0),T(100));f.Ready(T(-1),7);f.Switch(T(0),9,7,5,4);f.Switch(T(30),7,9,5,4);f.Switch(T(60),9,7,5,4);f.Switch(T(100),7,9,5,4);var fx=f.Finish();Check(N(fx,"transition_errors")==1&&N(fx,"wait_ms")==0&&N(fx,"covered_ms")==70);tests++;
  var g=new SchedulerLedger(7,0,70000);g.Ready(-1,7);for(int i=0;i<32770;i++){g.Switch(i*2,9,7,5,4);g.Switch(i*2+1,7,9,1,0);}g.Switch(70000,9,7,5,4);var gx=g.Finish();var dist=(Dictionary<string,object>)gx["running_intervals"];Check(N(gx,"distribution_overflow")>0&&dist["p50_ms"]==null&&N(dist,"samples")==32768);tests++;
  return tests;
 }
}
'@
} catch {
    $reply=@{kind='SCHEDULING_LOAD';event='closed';phase=$null;status='NOT_VERIFIED';failure_code='native_compile_unverified';capacity_approval=$false;utc_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();qpc_ticks=[Diagnostics.Stopwatch]::GetTimestamp();qpc_frequency=[Diagnostics.Stopwatch]::Frequency;native_error_code=$null}
    [Console]::Out.WriteLine(($reply|ConvertTo-Json -Compress));exit 2
}
$traceProfileXml = @'
<?xml version="1.0" encoding="utf-8"?>
<WindowsPerformanceRecorder Version="1.0" Author="SchedulingPreflight">
 <Profiles>
  <SystemCollector Id="SystemCollector" Name="SchedulingPreflight"><BufferSize Value="128"/><Buffers Value="256"/></SystemCollector>
  <SystemProvider Id="SystemProvider"><Keywords><Keyword Value="ProcessThread"/><Keyword Value="CSwitch"/><Keyword Value="ReadyThread"/></Keywords></SystemProvider>
  <Profile Id="SchedulingPreflight.Light.Memory" Name="SchedulingPreflight" Description="Synthetic scheduler decoder check" LoggingMode="Memory" DetailLevel="Light"><Collectors><SystemCollectorId Value="SystemCollector"><SystemProviderId Value="SystemProvider"/></SystemCollectorId></Collectors></Profile>
  <Profile Id="SchedulingPreflight.Light.File" Name="SchedulingPreflight" Description="Synthetic scheduler decoder check" LoggingMode="File" DetailLevel="Light"><Collectors><SystemCollectorId Value="SystemCollector"><SystemProviderId Value="SystemProvider"/></SystemCollectorId></Collectors></Profile>
 </Profiles>
</WindowsPerformanceRecorder>
'@
$extraCodes = @('guard_unverified','command_schema','input_json','input_bound','input_incomplete','input_eof','phase_sequence','duration_invalid','attach_required','already_attached','companion_failed','window_too_short','window_too_long','global_deadline','window_deadline','output_bound','trace_incomplete','trace_not_recording','cpu_queries_unverified','counter_zero_ambiguous','query_windows_differ','timestamp_regressive','target_events_missing','left_boundary_unknown','right_boundary_unknown','state_transition_unknown','state_unsupported','distribution_bound','partial_interval_coverage','not_decoded','process_query_failed','creation_query_failed','description_query_failed','window_query_failed','window_owner_changed','installed_path_unverified','main_hash_mismatch','process_not_unique','process_identity_unverified','window_not_unique','roles_not_distinct','thread_open_failed','thread_enumeration_unverified','capture_description_not_unique','role_invalid','process_changed','subject_changed','thread_changed')
$failureCodes += $extraCodes
$roles = @('capture','ui'); $phases = @('control_before','instrumented','control_after')
$report = @{ last_native_tool='none'; native_tool_results=@{ wpr=@{calls=0;last_exit_code=$null;last_nonzero_exit_code=$null;last_timed_out=$false;timeouts=0;start_failures=0};logman=@{calls=0;last_exit_code=$null;last_nonzero_exit_code=$null;last_timed_out=$false;timeouts=0;start_failures=0};tracerpt=@{calls=0;last_exit_code=$null;last_nonzero_exit_code=$null;last_timed_out=$false;timeouts=0;start_failures=0} } }
$owner=$null; $active=$null; $attached=$false; $next=0; $windows=@{}; $traceMayExist=$false; $traceFlushed=$false; $private=$null; $instance=$null; $wpr=$null; $tracerpt=$null; $etl=$null; $profilePath=$null; $dropped=$null; $totalOutput=0; $fatal='none'; $pendingCloseFailure=$null; $cleanup='NOT_NEEDED'; $loadClock=[Diagnostics.Stopwatch]::StartNew()
function Failure-From($Record) {
    $ex=$Record.Exception
    for($i=0;$i -lt 8 -and $null -ne $ex;$i++) {
        if($ex -is [SchedulingFault]) { return @{code=(Resolve-Failure $ex.Code);native=$ex.NativeCode;visible=$ex.VisibleCandidates;matches=$ex.TitleMatches} }
        if($ex.Message -cin $failureCodes) { return @{code=$ex.Message;native=$null;visible=$null;matches=$null} }
        $ex=$ex.InnerException
    }
    return @{code='unexpected_failure';native=$null;visible=$null;matches=$null}
}
function Emit-Reply([string]$Event,$Phase,[string]$Status,[string]$Code,$Window=$null,$Cpu=$null,$Trace=$null,$Native=$null,$Visible=$null,$TitleMatches=$null) {
    $value=@{kind='SCHEDULING_LOAD';event=$Event;phase=$Phase;status=$Status;failure_code=(Resolve-Failure $Code);capacity_approval=$false;utc_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();qpc_ticks=[Diagnostics.Stopwatch]::GetTimestamp();qpc_frequency=[Diagnostics.Stopwatch]::Frequency;native_error_code=$Native}
    if($null -ne $Visible){$value.identity_visible_candidates=[int]$Visible};if($null -ne $TitleMatches){$value.identity_title_matches=[int]$TitleMatches}
    if($null -ne $Window){$value.window=$Window};if($null -ne $Cpu){$value.cpu=$Cpu};if($null -ne $Trace){$value.trace=$Trace}
    $line=$value | ConvertTo-Json -Depth 12 -Compress
    $bytes=[Text.Encoding]::UTF8.GetByteCount($line)+1
    if($bytes -gt 65536 -or $script:totalOutput+$bytes -gt 1048576){throw 'output_bound'}
    $script:totalOutput+=$bytes
    [Console]::Out.WriteLine($line);[Console]::Out.Flush()
}
function Parse-Command([string]$Line) {
    if($Line.Length -gt 65536 -or $Line -cmatch '[^\x00-\x7f]'){throw 'input_bound'}
    try {$doc=[Text.Json.JsonDocument]::Parse($Line)}catch{throw 'input_json'}
    try {
        if($doc.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Object){throw 'command_schema'}
        $fields=@{};$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach($prop in $doc.RootElement.EnumerateObject()){
            if(-not $seen.Add($prop.Name) -or $prop.Name -cnotin @('command','phase','duration_ms')){throw 'command_schema'}
            if($prop.Name -eq 'duration_ms'){
                [int]$n=0;if($prop.Value.ValueKind -ne [Text.Json.JsonValueKind]::Number -or -not $prop.Value.TryGetInt32([ref]$n) -or $n -ne 2000){throw 'duration_invalid'};$fields.duration_ms=$n
            }else{if($prop.Value.ValueKind -ne [Text.Json.JsonValueKind]::String){throw 'command_schema'};$fields[$prop.Name]=$prop.Value.GetString()}
        }
        if(-not $fields.ContainsKey('command') -or $fields.command -cnotin @('attach','begin','end','close')){throw 'command_schema'}
        $count=if($fields.command -eq 'begin'){3}elseif($fields.command -eq 'end'){2}else{1}
        if($fields.Count -ne $count){throw 'command_schema'}
        if($fields.command -in @('begin','end') -and (-not $fields.ContainsKey('phase') -or $fields.phase -cnotin $phases)){throw 'command_schema'}
        return $fields
    }finally{$doc.Dispose()}
}
function New-PrivateTrace {
    $script:wpr=Join-Path $env:windir 'System32/wpr.exe';$script:tracerpt=Join-Path $env:windir 'System32/tracerpt.exe';$logman=Join-Path $env:windir 'System32/logman.exe'
    foreach($tool in @($wpr,$tracerpt,$logman)){if(-not [IO.File]::Exists($tool)){throw 'tools_or_access_unavailable'}}
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent());if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'tools_or_access_unavailable'}
    $sessions=Invoke-Inbox $logman @('query','-ets');if($sessions.code -ne 0){throw 'native_tool_nonzero_exit'}
    $state=Invoke-Inbox $wpr @('-status');$bad=Get-SessionFailure $sessions.code $sessions.text $state.text;if($bad -ne 'none'){throw $bad}
    $script:instance='SchedulingLoad'+[Guid]::NewGuid().ToString('N');$script:private=Join-Path $env:RUNNER_TEMP $instance
    if(Test-Path -LiteralPath $private){throw 'private_path_already_exists'};[void][IO.Directory]::CreateDirectory($private)
    $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};Set-Acl -LiteralPath $private -AclObject $acl
    $script:profilePath=Join-Path $private 'scheduler.wprp';$script:etl=Join-Path $private 'private.etl'
    [IO.File]::WriteAllText($profilePath,$traceProfileXml,[Text.UTF8Encoding]::new($false))
    $details=Invoke-Inbox $wpr @('-profiledetails',($profilePath+'!SchedulingPreflight.Light'))
    if($details.code -ne 0 -or $details.text -notmatch 'Memory' -or $details.text -notmatch 'CSwitch' -or $details.text -notmatch 'ReadyThread'){throw 'profile_not_verified'}
}
function Begin-Trace {
    $script:traceMayExist=$true;$script:cleanup='PENDING'
    $start=Invoke-Inbox $wpr @('-start',($profilePath+'!SchedulingPreflight.Light'),'-instancename',$instance)
    if($start.code -ne 0){throw 'native_tool_nonzero_exit'}
    $state=Invoke-Inbox $wpr @('-status','-instancename',$instance)
    if($state.code -ne 0 -or $state.text -notmatch '(?i)recording is in progress' -or $state.text -notmatch 'Memory'){throw 'trace_not_recording'}
}
function Flush-Trace {
    if(-not $traceMayExist){return}
    $state=Invoke-Inbox $wpr @('-status','collectors','-details','-instancename',$instance)
    $dropMatches=[regex]::Matches($state.text,'(?im)^\s*Dropped event\s*:\s*(\d+)\s*$');if($state.code -eq 0 -and $dropMatches.Count -eq 1){$script:dropped=[long]$dropMatches[0].Groups[1].Value}
    $stop=Invoke-Inbox $wpr @('-stop',$etl,'-skipPdbGen','-instancename',$instance) 60
    if($stop.code -ne 0){throw 'native_tool_nonzero_exit'}
    $script:traceMayExist=$false;$script:traceFlushed=$true
    $after=Invoke-Inbox $wpr @('-status','-instancename',$instance)
    if($after.text -notmatch '(?i)\bnot recording\b'){throw 'owned_session_cleanup_not_verified'};$script:cleanup='VERIFIED'
}
function Window-Data($Start,$End=$null) {
    $a=$Start.Export();$out=@{start_utc_ms=$a.utc_ms;start_qpc_ticks=$Start.Qpc;qpc_frequency=[Diagnostics.Stopwatch]::Frequency}
    if($null -ne $End){$b=$End.Export();$out.end_utc_ms=$b.utc_ms;$out.end_qpc_ticks=$End.Qpc;$out.elapsed_ms=([double]($End.Qpc-$Start.Qpc)*1000.0)/[Diagnostics.Stopwatch]::Frequency}
    return $out
}
function Read-PrivateField($Record,[string]$Name){
    foreach($node in $Record.SelectNodes('/*[local-name()="Event"]/*[local-name()="EventData"]/*')){if(($node.LocalName -eq 'Data' -and $node.GetAttribute('Name') -ceq $Name) -or $node.LocalName -ceq $Name){return Read-U32 $node.InnerText}}
    return $null
}
function Decode-Trace {
    $out=@{status='NOT_VERIFIED';failure_code='not_decoded';integrity='NOT_VERIFIED';events=0;malformed_scheduler=0;lost_events=$null;lost_buffers=$null;dropped_events=$dropped;etl_bytes=$null;xml_bytes=$null;roles=@{};schema_shape=@{provider_guid=0;extended_guid=0;opcode=0;named_fields=0;direct_fields=0;thread_headers=0;log_headers=0;header_fields_missing=0;header_fields_invalid=0};field_shapes=(New-FieldShapes);native_tools=$report.native_tool_results}
    if($next -ne 3 -or -not $traceFlushed -or -not $windows.ContainsKey('instrumented')){$out.failure_code='trace_incomplete';return $out}
    $window=$windows.instrumented;$ledgers=@{};foreach($role in $roles){$ledgers[$role]=[SchedulerLedger]::new($owner.RoleId($role),$window.start.UtcTicks,$window.end.UtcTicks)}
    try{
        $owner.Validate();$size=(Get-Item -LiteralPath $etl).Length;$out.etl_bytes=$size;if($size -le 0 -or $size -gt 134217728){throw 'etl_size_bound'}
        $xml=Join-Path $private 'private.xml';$summary=Join-Path $private 'private-summary.txt'
        $converted=Invoke-Inbox $tracerpt @($etl,'-o',$xml,'-of','XML','-summary',$summary,'-y') 60
        if($converted.code -ne 0){throw 'native_tool_nonzero_exit'}
        $size=(Get-Item -LiteralPath $xml).Length;$out.xml_bytes=$size;if($size -le 0 -or $size -gt 268435456){throw 'xml_size_bound'}
        $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=268435456
        $reader=[Xml.XmlReader]::Create($xml,$settings);$lost=[Collections.Generic.List[uint32]]::new();$buffers=[Collections.Generic.List[uint32]]::new()
        try{
            while($reader.Read()){
                if($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'Event'){continue}
                $out.events++;if($out.events -gt 1000000){throw 'event_count_bound'}
                $sub=$reader.ReadSubtree();try{$record=[xml]::new();$record.XmlResolver=$null;$record.Load($sub)}finally{$sub.Dispose()}
                $decoded=Decode-Event $record 0
                foreach($key in @($out.schema_shape.Keys)){$out.schema_shape[$key]+=$decoded.shape[$key]}
                foreach($field in $schemaFields){foreach($key in $fieldShapeKeys){$out.field_shapes[$field][$key]+=$decoded.field_shapes[$field][$key]}}
                if($null -ne $decoded.events_lost){$lost.Add($decoded.events_lost)};if($null -ne $decoded.buffers_lost){$buffers.Add($decoded.buffers_lost)}
                if($decoded.kind -eq 'other'){continue};if(-not $decoded.valid){$out.malformed_scheduler++;continue}
                $old=$null;$new=$null;$ready=$null;$state=$null;$reason=$null
                if($decoded.kind -eq 'cswitch'){$old=Read-PrivateField $record 'OldThreadId';$new=Read-PrivateField $record 'NewThreadId';$state=Read-PrivateField $record 'OldThreadState';$reason=Read-PrivateField $record 'OldThreadWaitReason'}else{$ready=Read-PrivateField $record 'TThreadId'}
                foreach($role in $roles){$id=$owner.RoleId($role);if($old -ne $id -and $new -ne $id -and $ready -ne $id){continue}
                    $time=$record.SelectSingleNode('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="TimeCreated"]/@SystemTime');$timeline=New-Timeline;$raw=if($null -eq $time){$null}else{$time.Value};Add-TargetTimestamp $timeline $raw
                    if((Get-TimelineFailure $timeline) -ne 'none'){$ledgers[$role].InvalidTimestamp((Get-TimelineFailure $timeline));continue}
                    if($decoded.kind -eq 'cswitch'){$ledgers[$role].Switch($timeline.last,$old,$new,$state,$reason)}else{$ledgers[$role].Ready($timeline.last,$ready)}
                }
            }
        }finally{$reader.Dispose()}
        if($lost.Count -gt 0){$out.lost_events=($lost|Measure-Object -Maximum).Maximum};if($buffers.Count -gt 0){$out.lost_buffers=($buffers|Measure-Object -Maximum).Maximum}
        $integrity=Get-IntegrityFailure $out.schema_shape $out.lost_events $out.lost_buffers $dropped;if($integrity -eq 'none'){$out.integrity='VERIFIED'}
        foreach($role in $roles){$out.roles[$role]=$ledgers[$role].Finish()}
        if($out.malformed_scheduler -gt 0){throw 'scheduler_malformed'};if($integrity -ne 'none'){throw $integrity}
        $out.failure_code='none';$out.status='OBSERVED'
        foreach($role in $roles){if($out.roles[$role].status -ne 'OBSERVED'){$out.status='NOT_VERIFIED';$out.failure_code=$out.roles[$role].failure_code;break}}
    }catch{$out.failure_code=(Failure-From $_).code;$out.status='NOT_VERIFIED';foreach($role in $roles){if(-not $out.roles.ContainsKey($role)){$out.roles[$role]=$ledgers[$role].Finish()}}}
    return $out
}
try {
    if($SelfTest){$n=(Test-Decoder)+(Test-AdditionalGuards)+(Test-FieldShapes)+(Test-HeaderWhitespace);$models=[SchedulerLedgerTests]::Run();[Console]::Out.WriteLine(('{"kind":"SCHEDULING_SELFTEST","decoder_fixtures":'+$n+',"model_fixtures":'+$models+',"capacity_approval":false}'));exit 0}
    if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'BersaneV/Harmony' -or $env:GITHUB_REF -cne 'refs/heads/main' -or $env:RUNNER_OS -cne 'Windows' -or $env:HARMONY_SCHEDULER_LOAD_PUBLIC_REPOSITORY -cne 'true' -or $env:HARMONY_EXE_RELEASE -cne '0.4.9' -or $env:HARMONY_CLIENT_INDEX -cne '0' -or $env:HARMONY_EXE_PROFILE -cnotin @('1080p60','1440p60') -or -not [IO.Directory]::Exists($env:RUNNER_TEMP)){throw 'guard_unverified'}
    while($true){
        $task=[SchedulingInput]::Read()
        while(-not $task.Wait(250)){
            if($loadClock.Elapsed.TotalSeconds -gt 600){throw 'global_deadline'}
            if($null -ne $active -and (([Diagnostics.Stopwatch]::GetTimestamp()-$active.start.Qpc)*1000.0/[Diagnostics.Stopwatch]::Frequency) -ge 5000){throw 'window_deadline'}
        }
        $line=$task.GetAwaiter().GetResult();if($null -eq $line){throw 'input_eof'}
        $cmd=Parse-Command $line;$phase=if($cmd.ContainsKey('phase')){$cmd.phase}else{$null}
        try {
            if($cmd.command -eq 'attach'){
                if($attached){throw 'already_attached'}
                $owner=[SchedulingOwner]::new($env:HARMONY_EXE_PATH,$env:HARMONY_EXE_ROOT,$env:RUNNER_TEMP);New-PrivateTrace;$attached=$true
                Emit-Reply 'attached' $null 'OBSERVED' 'none' -Visible $owner.IdentityVisibleCandidates -TitleMatches $owner.IdentityTitleMatches;continue
            }
            if($cmd.command -eq 'close'){
                if($null -ne $active){$fatal='trace_incomplete';$active=$null}
                if($traceMayExist){Flush-Trace}
                $trace=Decode-Trace
                if($null -ne $owner){$owner.Dispose();$owner=$null}
                Emit-Reply 'closed' $null 'OBSERVED' 'none' $null $null $trace
                break
            }
            if(-not $attached){throw 'attach_required'};if($fatal -ne 'none'){throw 'companion_failed'}
            if($cmd.command -eq 'begin'){
                if($null -ne $active -or $next -ge 3 -or $phase -cne $phases[$next]){throw 'phase_sequence'}
                $owner.Validate();if($phase -eq 'instrumented'){Begin-Trace}
                $samples=@{};foreach($role in $roles){$samples[$role]=$owner.Read($role)}
                $start=[SchedulerNative]::Now();$active=@{phase=$phase;start=$start;samples=$samples}
                Emit-Reply 'begun' $phase 'OBSERVED' 'none' (Window-Data $start);continue
            }
            if($cmd.command -eq 'end'){
                if($null -eq $active -or $phase -cne $active.phase){throw 'phase_sequence'}
                $stop=[SchedulerNative]::Now();$cpu=@{};foreach($role in $roles){$cpu[$role]=[SchedulerNative]::Delta($active.samples[$role],$owner.Read($role))};$owner.Validate()
                $window=Window-Data $active.start $stop;$windows[$phase]=@{start=$active.start;end=$stop};$active=$null;$next++
                if($phase -eq 'instrumented'){Flush-Trace}
                $code=if($window.elapsed_ms -lt 2000){'window_too_short'}elseif($window.elapsed_ms -ge 5000){'window_too_long'}else{'none'}
                Emit-Reply 'ended' $phase $(if($code -eq 'none'){'OBSERVED'}else{'NOT_VERIFIED'}) $code $window $cpu;continue
            }
        }catch{
            $failure=Failure-From $_;$fatal=$failure.code
            $event=switch($cmd.command){'attach'{'attached'}'begin'{'begun'}'end'{'ended'}default{'closed'}}
            if($event -ne 'closed'){Emit-Reply $event $phase 'NOT_VERIFIED' $failure.code $null $null $null $failure.native $failure.visible $failure.matches}
            if($event -eq 'closed'){$pendingCloseFailure=$failure;break}
        }
    }
}catch{
    $failure=Failure-From $_;$fatal=$failure.code
    $pendingCloseFailure=$failure
}finally{
    if($traceMayExist -and $null -ne $instance -and $null -ne $wpr){try{[void](Invoke-Inbox $wpr @('-cancel','-instancename',$instance));$after=Invoke-Inbox $wpr @('-status','-instancename',$instance);if($after.text -notmatch '(?i)\bnot recording\b'){$fatal='owned_session_cleanup_not_verified'}}catch{$fatal='owned_session_cleanup_not_verified'}}
    if($null -ne $owner){$owner.Dispose()}
}
if($null -ne $pendingCloseFailure){try{Emit-Reply 'closed' $null 'NOT_VERIFIED' $fatal $null $null $null $pendingCloseFailure.native $pendingCloseFailure.visible $pendingCloseFailure.matches}catch{}}
if($fatal -ne 'none'){exit 2}
exit 0
