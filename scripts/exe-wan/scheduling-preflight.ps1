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

$report = [ordered]@{
    kind = 'SYNTHETIC_DECODER_CHECK'; status = 'NOT_VERIFIED'; capacity_approval = $false
    failure_code = 'not_started'; last_native_tool = 'none'; failure_native_tool = 'none'; failure_native_exit_code = $null; failure_native_timed_out = $false
    native_tool_results = @{ wpr=@{ calls=0; last_exit_code=$null; last_nonzero_exit_code=$null; last_timed_out=$false; timeouts=0; start_failures=0 }; logman=@{ calls=0; last_exit_code=$null; last_nonzero_exit_code=$null; last_timed_out=$false; timeouts=0; start_failures=0 }; tracerpt=@{ calls=0; last_exit_code=$null; last_nonzero_exit_code=$null; last_timed_out=$false; timeouts=0; start_failures=0 } }
    tools = [ordered]@{ wpr = $false; tracerpt = $false; logman = $false; administrator = $false; profile = $false }
    fixture_tests = 0; stage = 'guard'; cleanup = 'NOT_NEEDED'
    memory_buffer_mib = 32; workload_seconds_requested = 10; workload_busy_ms = 20; workload_sleep_ms = 10; managed_fixture_tests = 0
    cpu_api = $null; cpu_cycles_verified = $false; field_shapes = (New-FieldShapes); schema_metadata = @{ status='NOT_VERIFIED'; classes_available=0; query_failures=0; fields=@{} }
    description_verified = $false; cpu_times_verified = $false; elapsed_ms = $null; user_cpu_ms = $null; kernel_cpu_ms = $null; sleep_calls = 0
    schema = 'Thread_V2:36,50; named EventData/Data or direct fields; uint32 decimal/hex'
    decoder = [ordered]@{ status = 'NOT_VERIFIED'; events = 0; cswitch = 0; readythread = 0; malformed_scheduler = 0; target_in = 0; target_out = 0; target_ready = 0; target_delay_execution = 0; target_events = 0; timestamped_target_events = 0; timestamps_missing = 0; timestamps_invalid = 0; timestamps_nonfinite = 0; timestamps_regressive = 0; target_span_ms = $null; wait_reason_counts = @{} }
    schema_shape = @{ provider_guid=0; extended_guid=0; opcode=0; named_fields=0; direct_fields=0; thread_headers=0; log_headers=0; header_fields_missing=0; header_fields_invalid=0 }
    lost_events = $null; lost_buffers = $null; dropped_events_before_flush = $null
    trace_integrity = 'NOT_VERIFIED'; etl_bytes = $null; xml_bytes = $null
}
$ownedInstance = $null; $attemptedStart = $false; $worker = $null; $private = $null; $wpr = $null
try {
    $report.fixture_tests = (Test-Decoder) + (Test-AdditionalGuards) + (Test-FieldShapes) + (Test-HeaderWhitespace)
    if ($SelfTest) {
        $report.kind = 'SCHEMA_FIXTURE_CHECK_ONLY'
        $report.stage = 'SCHEMA_FIXTURE_CHECK_ONLY'
        $report.status = 'VERIFIED'; $report.failure_code = 'none'
    } else {
        if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_REPOSITORY -ne 'BersaneV/Harmony' -or $env:GITHUB_REF -ne 'refs/heads/main' -or $env:RUNNER_OS -ne 'Windows' -or -not [IO.Directory]::Exists($env:RUNNER_TEMP)) { throw 'owned_windows_runner_required' }
        $report.stage = 'tools'
        $wpr = Join-Path $env:windir 'System32/wpr.exe'
        $tracerpt = Join-Path $env:windir 'System32/tracerpt.exe'
        $logman = Join-Path $env:windir 'System32/logman.exe'
        $report.tools.wpr = [IO.File]::Exists($wpr)
        $report.tools.tracerpt = [IO.File]::Exists($tracerpt)
        $report.tools.logman = [IO.File]::Exists($logman)
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        $report.tools.administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if (-not ($report.tools.wpr -and $report.tools.tracerpt -and $report.tools.logman -and $report.tools.administrator)) { throw 'tools_or_access_unavailable' }
        $report.stage = 'existing_session'
        $sessions = Invoke-Inbox $logman @('query','-ets')
        if ($sessions.code -ne 0) { throw (Get-NativeFailure $true $false $sessions.code) }
        $status = Invoke-Inbox $wpr @('-status')
        $sessionFailure = Get-SessionFailure $sessions.code $sessions.text $status.text
        if ($sessionFailure -ne 'none') { throw $sessionFailure }
        $ownedInstance = 'SchedulingPreflight' + [Guid]::NewGuid().ToString('N')
        $private = Join-Path $env:RUNNER_TEMP $ownedInstance
        if (Test-Path -LiteralPath $private) { throw 'private_path_already_exists' }
        [void][IO.Directory]::CreateDirectory($private)
        # ACL first: only this disposable runner identity and SYSTEM. Never upload.
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $private -AclObject $acl
        $traceProfile = Join-Path $private 'scheduler.wprp'
        @'
<?xml version="1.0" encoding="utf-8"?>
<WindowsPerformanceRecorder Version="1.0" Author="SchedulingPreflight">
 <Profiles>
  <SystemCollector Id="SystemCollector" Name="SchedulingPreflight"><BufferSize Value="128"/><Buffers Value="256"/></SystemCollector>
  <SystemProvider Id="SystemProvider"><Keywords><Keyword Value="ProcessThread"/><Keyword Value="CSwitch"/><Keyword Value="ReadyThread"/></Keywords></SystemProvider>
  <Profile Id="SchedulingPreflight.Light.Memory" Name="SchedulingPreflight" Description="Synthetic scheduler decoder check" LoggingMode="Memory" DetailLevel="Light"><Collectors><SystemCollectorId Value="SystemCollector"><SystemProviderId Value="SystemProvider"/></SystemCollectorId></Collectors></Profile>
  <Profile Id="SchedulingPreflight.Light.File" Name="SchedulingPreflight" Description="Synthetic scheduler decoder check" LoggingMode="File" DetailLevel="Light"><Collectors><SystemCollectorId Value="SystemCollector"><SystemProviderId Value="SystemProvider"/></SystemCollectorId></Collectors></Profile>
 </Profiles>
</WindowsPerformanceRecorder>
'@ | Set-Content -LiteralPath $traceProfile -Encoding utf8NoBOM
        $report.stage = 'profile'
        $details = Invoke-Inbox $wpr @('-profiledetails', ($traceProfile + '!SchedulingPreflight.Light'))
        if ($details.code -ne 0) { throw (Get-NativeFailure $true $false $details.code) }
        $report.tools.profile = $details.code -eq 0 -and $details.text -match 'CSwitch' -and $details.text -match 'ReadyThread' -and $details.text -match 'ProcessThread' -and $details.text -match 'Memory'
        if (-not $report.tools.profile) { throw 'profile_not_verified' }
        $report.schema_metadata = Read-StaticSchemaMetadata
        $report.stage = 'native_apis'
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class SyntheticSchedulerWorker : IDisposable {
 [StructLayout(LayoutKind.Sequential)] public struct NativeFileTime {
  public uint Low; public uint High;
  public ulong Ticks() { return ((ulong)High << 32) | Low; }
 }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int SetThreadDescription(IntPtr t, string name);
 [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr t, out IntPtr name);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
 [DllImport("kernel32.dll", EntryPoint="GetThreadTimes", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool GetThreadTimesLong(IntPtr t, out long created, out long ended, out long kernel, out long user);
 [DllImport("kernel32.dll", EntryPoint="GetThreadTimes", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool GetThreadTimesStruct(IntPtr t, out NativeFileTime created, out NativeFileTime ended, out NativeFileTime kernel, out NativeFileTime user);
 [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] static extern bool QueryThreadCycleTime(IntPtr t, out ulong cycles);
 sealed class CpuSample {
  public bool LongOk, StructOk, CycleOk;
  public int? LongError, StructError, CycleError;
  public long LongKernel, LongUser;
  public ulong StructKernel, StructUser, Cycles;
  public double BeforeMs, AfterMs;
  public Dictionary<string,object> Export() {
   return new Dictionary<string,object> {
    {"long_bool",LongOk},{"long_last_error",LongError},{"struct_bool",StructOk},{"struct_last_error",StructError},{"cycle_bool",CycleOk},{"cycle_last_error",CycleError},
    {"long_kernel_100ns",LongOk?(object)LongKernel:null},{"long_user_100ns",LongOk?(object)LongUser:null},
    {"struct_kernel_100ns",StructOk?(object)StructKernel:null},{"struct_user_100ns",StructOk?(object)StructUser:null},{"cycles",CycleOk?(object)Cycles:null},
    {"query_before_ms",BeforeMs},{"query_after_ms",AfterMs}
   };
  }
 }
 static CpuSample Sample(IntPtr t, Stopwatch audit) {
  CpuSample s=new CpuSample(); long c,e; NativeFileTime fc,fe,fk,fu;
  s.BeforeMs=audit.Elapsed.TotalMilliseconds;
  s.LongOk=GetThreadTimesLong(t,out c,out e,out s.LongKernel,out s.LongUser);
  if(!s.LongOk) s.LongError=Marshal.GetLastWin32Error();
  s.StructOk=GetThreadTimesStruct(t,out fc,out fe,out fk,out fu);
  if(!s.StructOk) s.StructError=Marshal.GetLastWin32Error();
  if(s.StructOk) { s.StructKernel=fk.Ticks(); s.StructUser=fu.Ticks(); }
  s.CycleOk=QueryThreadCycleTime(t,out s.Cycles);
  if(!s.CycleOk) s.CycleError=Marshal.GetLastWin32Error();
  s.AfterMs=audit.Elapsed.TotalMilliseconds;
  return s;
 }
 readonly ManualResetEventSlim ready=new ManualResetEventSlim(), go=new ManualResetEventSlim(), done=new ManualResetEventSlim(), release=new ManualResetEventSlim();
 readonly Thread thread;
 volatile bool cancel;
 CpuSample before, after;
 public uint NativeId { get; private set; }
 public bool DescriptionOk { get; private set; }
 public int? DescriptionSetHResult { get; private set; }
 public int? DescriptionGetHResult { get; private set; }
 public bool TimesOk { get; private set; }
 public bool StructTimesOk { get; private set; }
 public bool CyclesOk { get; private set; }
 public ulong CycleDelta { get; private set; }
 public double ElapsedMs { get; private set; }
 public double KernelMs { get; private set; }
 public double UserMs { get; private set; }
 public double StructKernelMs { get; private set; }
 public double StructUserMs { get; private set; }
 public double WorkStartAuditMs { get; private set; }
 public double WorkEndAuditMs { get; private set; }
 public long Sleeps { get; private set; }
 long checksum;
 public SyntheticSchedulerWorker() { thread=new Thread(Work); thread.IsBackground=true; thread.Start(); }
 public static int ManagedSelfTest() {
  if(Marshal.SizeOf<NativeFileTime>()!=8 || Marshal.OffsetOf<NativeFileTime>("Low").ToInt32()!=0 || Marshal.OffsetOf<NativeFileTime>("High").ToInt32()!=4 || sizeof(long)!=8) throw new InvalidOperationException();
  if(new NativeFileTime{Low=0x89abcdef,High=0x01234567}.Ticks()!=0x0123456789abcdefUL) throw new InvalidOperationException();
  if(new NativeFileTime{Low=uint.MaxValue,High=uint.MaxValue}.Ticks()!=ulong.MaxValue) throw new InvalidOperationException();
  if(new NativeFileTime{Low=0,High=0}.Ticks()!=0) throw new InvalidOperationException();
  return 7;
 }
 void Work() {
  try {
   NativeId=GetCurrentThreadId(); IntPtr t=GetCurrentThread(); IntPtr name=IntPtr.Zero;
   DescriptionSetHResult=SetThreadDescription(t,"scheduling-preflight-worker");
   if(DescriptionSetHResult>=0) {
    DescriptionGetHResult=GetThreadDescription(t,out name);
    try { if(DescriptionGetHResult>=0) DescriptionOk=Marshal.PtrToStringUni(name)=="scheduling-preflight-worker"; } finally { if(name!=IntPtr.Zero) LocalFree(name); }
   }
   ready.Set(); go.Wait(); if(cancel) return;
   Stopwatch audit=Stopwatch.StartNew(); before=Sample(t,audit); WorkStartAuditMs=audit.Elapsed.TotalMilliseconds;
   Stopwatch wall=Stopwatch.StartNew(); long value=1;
   // Counter calibration only: C5's1ms/Sleep2 produced0CPUtimes in run43950604603.
   // Longer CPU blocks test counter usability; they do not change Harmony.
   while(!cancel && wall.Elapsed.TotalSeconds<10) {
    long end=Stopwatch.GetTimestamp()+Stopwatch.Frequency/50;
    while(!cancel && Stopwatch.GetTimestamp()<end) { value=unchecked(value*1664525+1013904223); }
    if(!cancel) { Thread.Sleep(10); Sleeps++; }
   }
   ElapsedMs=wall.Elapsed.TotalMilliseconds; WorkEndAuditMs=audit.Elapsed.TotalMilliseconds; after=Sample(t,audit);
   TimesOk=before.LongOk && after.LongOk && before.LongKernel>=0 && before.LongUser>=0 && after.LongKernel>=before.LongKernel && after.LongUser>=before.LongUser;
   if(TimesOk) { KernelMs=(after.LongKernel-before.LongKernel)/10000.0; UserMs=(after.LongUser-before.LongUser)/10000.0; }
   StructTimesOk=before.StructOk && after.StructOk && after.StructKernel>=before.StructKernel && after.StructUser>=before.StructUser;
   if(StructTimesOk) { StructKernelMs=(after.StructKernel-before.StructKernel)/10000.0; StructUserMs=(after.StructUser-before.StructUser)/10000.0; }
   CyclesOk=before.CycleOk && after.CycleOk && after.Cycles>=before.Cycles;
   if(CyclesOk) CycleDelta=after.Cycles-before.Cycles;
   checksum=value; done.Set(); release.Wait(); // Keep this native TID alive through decoding.
  } catch { } finally { ready.Set(); done.Set(); }
 }
 public Dictionary<string,object> Audit() {
  return new Dictionary<string,object> {
   {"get_thread_times_return","BOOL"},{"description_set_hresult",DescriptionSetHResult},{"description_get_hresult",DescriptionGetHResult},
   {"filetime_bytes",Marshal.SizeOf<NativeFileTime>()},{"filetime_low_offset",Marshal.OffsetOf<NativeFileTime>("Low").ToInt32()},{"filetime_high_offset",Marshal.OffsetOf<NativeFileTime>("High").ToInt32()},{"long_bytes",sizeof(long)},
   {"start",before==null?null:before.Export()},{"end",after==null?null:after.Export()},{"work_start_ms",WorkStartAuditMs},{"work_end_ms",WorkEndAuditMs},
   {"long_monotonic",TimesOk},{"struct_monotonic",StructTimesOk},{"struct_kernel_ms",StructTimesOk?(object)StructKernelMs:null},{"struct_user_ms",StructTimesOk?(object)StructUserMs:null},
   {"cycles_monotonic",CyclesOk},{"cycles_delta",CyclesOk?(object)CycleDelta:null}
  };
 }
 public bool Ready() { return ready.Wait(5000) && NativeId!=0 && DescriptionOk; }
 public bool Run() { go.Set(); return done.Wait(15000); }
 public void Dispose() { cancel=true; go.Set(); release.Set(); if(thread.Join(5000)) { ready.Dispose(); go.Dispose(); done.Dispose(); release.Dispose(); } GC.KeepAlive(checksum); }
}
'@
        $report.managed_fixture_tests = [SyntheticSchedulerWorker]::ManagedSelfTest()
        $worker = [SyntheticSchedulerWorker]::new()
        if (-not $worker.Ready()) { $report.cpu_api = $worker.Audit(); throw 'thread_description_not_verified' }
        $report.description_verified = $true
        $report.stage = 'start'
        $attemptedStart = $true
        $start = Invoke-Inbox $wpr @('-start', ($traceProfile + '!SchedulingPreflight.Light'), '-instancename', $ownedInstance)
        if ($start.code -ne 0) { throw (Get-NativeFailure $true $false $start.code) }
        $report.cleanup = 'PENDING'
        $report.stage = 'synthetic_workload'
        if (-not $worker.Run()) { throw 'synthetic_workload_timeout' }
        $report.cpu_api = $worker.Audit()
        $report.elapsed_ms = $worker.ElapsedMs
        $report.user_cpu_ms = $worker.UserMs
        $report.kernel_cpu_ms = $worker.KernelMs
        $report.sleep_calls = $worker.Sleeps
        $report.cpu_times_verified = $worker.TimesOk -and $worker.UserMs + $worker.KernelMs -gt 0 -and $worker.StructTimesOk -and $worker.StructUserMs + $worker.StructKernelMs -gt 0
        $report.cpu_cycles_verified = $worker.CyclesOk -and $worker.CycleDelta -gt 0
        $report.stage = 'flush'
        $finalStatus = Invoke-Inbox $wpr @('-status','collectors','-details','-instancename',$ownedInstance)
        $drop = [regex]::Matches($finalStatus.text, '(?im)^\s*Dropped event\s*:\s*(\d+)\s*$')
        if ($finalStatus.code -eq 0 -and $drop.Count -eq 1) { $report.dropped_events_before_flush = [long]$drop[0].Groups[1].Value }
        $etl = Join-Path $private 'private.etl'
        $stop = Invoke-Inbox $wpr @('-stop',$etl,'-skipPdbGen','-instancename',$ownedInstance) 60
        if ($stop.code -ne 0) { throw (Get-NativeFailure $true $false $stop.code) }
        $attemptedStart = $false
        $after = Invoke-Inbox $wpr @('-status','-instancename',$ownedInstance)
        if ($after.text -notmatch '(?i)\bnot recording\b') { throw 'owned_session_cleanup_not_verified' }
        $report.cleanup = 'VERIFIED'
        $report.etl_bytes = (Get-Item -LiteralPath $etl).Length
        if ($report.etl_bytes -le 0 -or $report.etl_bytes -gt 134217728) { throw 'etl_size_bound' }
        $report.stage = 'decode'
        $xml = Join-Path $private 'private.xml'
        $summary = Join-Path $private 'private-summary.txt'
        $decode = Invoke-Inbox $tracerpt @($etl,'-o',$xml,'-of','XML','-summary',$summary,'-y') 60
        if ($decode.code -ne 0) { throw (Get-NativeFailure $true $false $decode.code) }
        if (-not [IO.File]::Exists($xml)) { throw 'tracerpt_output_missing' }
        $report.xml_bytes = (Get-Item -LiteralPath $xml).Length
        if ($report.xml_bytes -le 0 -or $report.xml_bytes -gt 268435456) { throw 'xml_size_bound' }
        $settings = [Xml.XmlReaderSettings]::new()
        $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
        $settings.XmlResolver = $null
        $settings.MaxCharactersInDocument = 268435456
        $reader = [Xml.XmlReader]::Create($xml, $settings)
        $loss = [Collections.Generic.List[uint32]]::new()
        $bufferLoss = [Collections.Generic.List[uint32]]::new()
        $timeline = New-Timeline
        try {
            while ($reader.Read()) {
                if ($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'Event') { continue }
                $report.decoder.events++
                if ($report.decoder.events -gt 1000000) { throw 'event_count_bound' }
                $sub = $reader.ReadSubtree()
                try { $eventDoc = [xml]::new(); $eventDoc.XmlResolver = $null; $eventDoc.Load($sub) } finally { $sub.Dispose() }
                $decoded = Decode-Event $eventDoc $worker.NativeId
                foreach ($field in $schemaFields) {
                    foreach ($key in $fieldShapeKeys) { $report.field_shapes[$field][$key] += $decoded.field_shapes[$field][$key] }
                }
                foreach ($shape in @($report.schema_shape.Keys)) { $report.schema_shape[$shape] += $decoded.shape[$shape] }
                if ($null -ne $decoded.events_lost) { $loss.Add($decoded.events_lost) }
                if ($null -ne $decoded.buffers_lost) { $bufferLoss.Add($decoded.buffers_lost) }
                if ($decoded.kind -eq 'other') { continue }
                if (-not $decoded.valid) { $report.decoder.malformed_scheduler++; continue }
                $report.decoder[$decoded.kind]++
                if ($decoded.incoming -or $decoded.outgoing -or $decoded.ready) {
                    $timeNode = $eventDoc.SelectSingleNode('/*[local-name()="Event"]/*[local-name()="System"]/*[local-name()="TimeCreated"]/@SystemTime')
                    $rawTime = if ($null -eq $timeNode) { $null } else { $timeNode.Value }
                    Add-TargetTimestamp $timeline $rawTime
                }
                if ($decoded.incoming) { $report.decoder.target_in++ }
                if ($decoded.outgoing) { $report.decoder.target_out++ }
                if ($decoded.ready) { $report.decoder.target_ready++ }
                if ($null -ne $decoded.wait_reason) {
                    if ($decoded.wait_reason -in @(4,11)) { $report.decoder.target_delay_execution++ }
                    $reason = [string]$decoded.wait_reason
                    if (-not $report.decoder.wait_reason_counts.ContainsKey($reason)) { $report.decoder.wait_reason_counts[$reason] = 0 }
                    $report.decoder.wait_reason_counts[$reason]++
                }
            }
        } finally { $reader.Dispose() }
        $report.decoder.target_events = $timeline.events
        $report.decoder.timestamped_target_events = $timeline.valid
        $report.decoder.timestamps_missing = $timeline.missing
        $report.decoder.timestamps_invalid = $timeline.invalid
        $report.decoder.timestamps_nonfinite = $timeline.nonfinite
        $report.decoder.timestamps_regressive = $timeline.regression
        $report.decoder.target_span_ms = Get-TimelineSpan $timeline
        if ($loss.Count -gt 0) { $report.lost_events = ($loss | Measure-Object -Maximum).Maximum }
        if ($bufferLoss.Count -gt 0) { $report.lost_buffers = ($bufferLoss | Measure-Object -Maximum).Maximum }
        $integrityFailure = Get-IntegrityFailure $report.schema_shape $report.lost_events $report.lost_buffers $report.dropped_events_before_flush
        if ($integrityFailure -eq 'none') { $report.trace_integrity = 'VERIFIED' }
        if ($report.decoder.cswitch -gt 0 -and $report.decoder.readythread -gt 0 -and $report.decoder.target_in -gt 0 -and $report.decoder.target_out -gt 0 -and $report.decoder.target_ready -gt 0 -and $report.decoder.target_delay_execution -gt 0 -and $report.decoder.malformed_scheduler -eq 0) { $report.decoder.status = 'VERIFIED' }
        if ($report.decoder.malformed_scheduler -gt 0) { throw 'scheduler_malformed' }
        if ($report.decoder.cswitch -eq 0 -or $report.decoder.readythread -eq 0) { throw 'scheduler_schema_missing' }
        if ($report.decoder.status -ne 'VERIFIED') { throw 'target_scheduler_missing' }
        $timelineFailure = Get-TimelineFailure $timeline
        if ($timelineFailure -ne 'none') { throw $timelineFailure }
        if ($integrityFailure -ne 'none') { throw $integrityFailure }
        if (-not $report.cpu_times_verified) { throw 'cpu_times_unverified' }
        if (-not $report.cpu_cycles_verified) { throw 'cpu_cycles_unverified' }
        foreach ($metric in @($report.elapsed_ms,$report.user_cpu_ms,$report.kernel_cpu_ms,$report.decoder.target_span_ms)) {
            if ($null -eq $metric -or [double]::IsNaN($metric) -or [double]::IsInfinity($metric)) { throw 'nonfinite_metrics' }
        }
        if ($report.sleep_calls -eq 0) { throw 'sleep_not_exercised' }
        if ($report.elapsed_ms -lt 10000 -or $report.elapsed_ms -ge 15000) { throw 'workload_duration_unverified' }
        if ($report.decoder.target_span_ms -lt ($report.elapsed_ms - 100)) { throw 'timestamp_span_insufficient' }
        if ($report.cleanup -ne 'VERIFIED') { throw 'owned_session_cleanup_not_verified' }
        $report.status = 'VERIFIED'; $report.failure_code = 'none'; $report.stage = 'complete'
    }
} catch {
    # Never emit native output, exception text, paths, session names, IDs or args.
    $report.status = 'NOT_VERIFIED'
    $report.failure_code = Resolve-Failure $_.Exception.Message
    $report.failure_native_tool = $report.last_native_tool
    if ($report.last_native_tool -ne 'none') {
        $report.failure_native_exit_code = $report.native_tool_results[$report.last_native_tool].last_exit_code
        $report.failure_native_timed_out = $report.native_tool_results[$report.last_native_tool].last_timed_out
    }
} finally {
    if ($null -ne $worker) {
        try { $worker.Dispose() } catch { $report.status = 'NOT_VERIFIED'; $report.cleanup = 'NOT_VERIFIED'; if ($report.failure_code -eq 'none') { $report.failure_code = 'worker_cleanup_not_verified' } }
    }
    if ($attemptedStart -and $null -ne $wpr -and $null -ne $ownedInstance) {
        try {
            [void](Invoke-Inbox $wpr @('-cancel','-instancename',$ownedInstance))
            $remaining = Invoke-Inbox $wpr @('-status','-instancename',$ownedInstance)
            $report.cleanup = if ($remaining.text -match '(?i)\bnot recording\b') { 'VERIFIED' } else { 'NOT_VERIFIED' }
        } catch { $report.cleanup = 'NOT_VERIFIED'; if ($report.failure_code -eq 'none') { $report.failure_code = 'owned_session_cleanup_not_verified' } }
    }
}
foreach ($field in @('elapsed_ms','user_cpu_ms','kernel_cpu_ms')) {
    if ($null -ne $report[$field] -and ([double]::IsNaN($report[$field]) -or [double]::IsInfinity($report[$field]))) { $report[$field] = $null }
}
# Strict aggregate-only projection. Raw files remain exclusively under RUNNER_TEMP.
$report | ConvertTo-Json -Depth 8 -Compress | Write-Output
if ($report.status -ne 'VERIFIED') { exit 2 }
exit 0
