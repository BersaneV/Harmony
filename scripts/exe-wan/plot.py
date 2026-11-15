#!/usr/bin/env python3
"""Plot an exported EXE-WAN report. QA tools: matplotlib==3.9.4, numpy==2.0.2."""
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

report = json.loads(Path(sys.argv[1]).read_text())
destination = Path(sys.argv[2])
phases = {p['phase']: p for p in report['phases']}
request = report.get('requested_profile', {'id':'720p30','width':1280,'height':720,'fps':30,'min_displayed_fps':24})
matrices = []
for phase in ('voice', 'screen'):
    values = np.full((8, 8), np.nan)
    for pair in phases[phase]['pairs']:
        if not pair['valid_reverse_pair']:
            continue
        a, b = pair['endpoints']
        values[a['client'], b['client']] = a['rtt_p95_ms']
        values[b['client'], a['client']] = b['rtt_p95_ms']
    matrices.append(values)

fig = plt.figure(figsize=(13.5, 9), facecolor='#f8fafc', layout='constrained')
grid = fig.add_gridspec(2, 2, height_ratios=[1.1, .85])
maximum = max((np.nanmax(m) for m in matrices if np.isfinite(m).any()), default=100)
for column, (matrix, title) in enumerate(zip(matrices, ['Voz · RTT p95 por par', 'Voz + tela · RTT p95 por par'])):
    axis = fig.add_subplot(grid[0, column])
    cmap = plt.get_cmap('YlGnBu').copy()
    cmap.set_bad('#e2e8f0')
    drawing = axis.imshow(np.ma.masked_invalid(matrix), vmin=0, vmax=maximum, cmap=cmap)
    axis.set_xticks(range(8), [f'P{i+1}' for i in range(8)])
    axis.set_yticks(range(8), [f'P{i+1}' for i in range(8)])
    axis.set_xlabel('Outro participante')
    axis.set_ylabel('Cliente que mediu')
    axis.set_title(title, loc='left', weight='bold', pad=12)
    for row in range(8):
        for col in range(8):
            value = matrix[row, col]
            label = '—' if row == col else f'{value:.0f}' if np.isfinite(value) else 'n/d'
            axis.text(col, row, label, ha='center', va='center', fontsize=9,
                      color='white' if np.isfinite(value) and value > maximum * .6 else '#0f172a')
    fig.colorbar(drawing, ax=axis, label='ms', shrink=.8)

fps_axis = fig.add_subplot(grid[1, 0])
video = [(client['index'], stream) for client in phases['screen']['clients']
         for peer in client['peers'] for stream in peer['streams'] if stream['source'] == 'screen']
positions = np.arange(len(video))
fps = [stream['displayed_fps'] or 0 for _, stream in video]
failed = {c['index'] for c in phases['screen']['clients'] if c['video_status'] == 'FAIL'}
fps_axis.bar(positions, fps, color=['#b45309' if index in failed else '#047857' for index, _ in video], width=.65)
fps_axis.axhline(request['fps'], color='#475569', linestyle=':', label=f"Solicitado: {request['fps']} FPS")
fps_axis.axhline(request['min_displayed_fps'], color='#b45309', linestyle='--', label=f"Meta do ensaio: {request['min_displayed_fps']} FPS")
fps_axis.set_xticks(positions, [f'P{index+1}' for index, _ in video])
fps_axis.set_ylim(0, max(request['fps']+5, max(fps, default=0) + 5))
fps_axis.set_ylabel('FPS exibidos · média na fase sustentada')
fps_axis.set_title(f"Uma janela {request['width']}×{request['height']} → sete espectadores", loc='left', weight='bold', pad=12)
for x, value, (index, stream) in zip(positions, fps, video):
    label = f'{value:.1f}' + (f"\n{stream['height']}p final" if index in failed else '')
    fps_axis.text(x, value + .5, label, ha='center', fontsize=9)
fps_axis.legend(loc='lower right', fontsize=8)
fps_axis.grid(axis='y', alpha=.2)

audio_axis = fig.add_subplot(grid[1, 1])
audio = []
for client in phases['screen']['clients']:
    values = [stream['concealment_ratio'] for peer in client['peers']
              for stream in peer['streams'] if stream['source'] == 'microphone'
              and stream['concealment_ratio'] is not None]
    audio.append(max(values) * 100 if values else np.nan)
audio_axis.bar(range(8), audio, color='#2563eb', width=.65)
audio_axis.set_xticks(range(8), [f'P{i+1}' for i in range(8)])
audio_axis.set_ylabel('Amostras de áudio reconstruídas (%)')
audio_axis.set_title('Voz durante a tela · pior fluxo por receptor', loc='left', weight='bold', pad=12)
audio_axis.set_ylim(0, max(.05, np.nanmax(audio) * 1.5))
audio_axis.grid(axis='y', alpha=.2)
for x, value in enumerate(audio):
    if np.isfinite(value):
        audio_axis.annotate(f'{value:.3f}%', (x, value), xytext=(0, 4), textcoords='offset points', ha='center', fontsize=8)

version = report.get('product', {}).get('version', '0.4.1')
voice_ok = all(c['voice_status'] == 'PASS' for c in phases['screen']['clients'])
result = ('voz passou' if voice_ok else 'voz falhou') + (', tela passou' if not failed else ', tela falhou em ' + ', '.join(f'P{i+1}' for i in sorted(failed)))
fig.suptitle(f"Harmony {version} · {request['id']} · oito EXEs Windows · {result}", fontsize=18, weight='bold')
fig.supxlabel('RTT: amostras do último valor ICE a cada ~3 s. Áudio gerado e janela de teste; ambiente de nuvem, sem medição de acústica física.', fontsize=9)
destination.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(destination, dpi=160, facecolor=fig.get_facecolor())
plt.close(fig)
print(str(destination))
