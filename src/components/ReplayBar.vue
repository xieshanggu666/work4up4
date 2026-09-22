<template>
  <div v-if="replay.replaying || replay.playing" class="replay-bar">
    <span class="rb-tag">🕘 复盘回放</span>
    <span v-if="replay.current" class="rb-info" :title="replay.current.label">
      <b>#{{ replay.current.seq }}</b>&nbsp;{{ replay.current.at }} · {{ replay.current.label }}
    </span>
    <div class="rb-controls">
      <button title="首个节点" @click="replay.viewEntry(0)">⏮</button>
      <button title="上一节点" @click="replay.step(-1)">⏪</button>
      <button class="play" :title="replay.playing ? '暂停' : '播放'" @click="togglePlay">
        {{ replay.playing ? '⏸' : '▶' }}
      </button>
      <button title="下一节点" @click="replay.step(1)">⏩</button>
      <button title="返回实时" @click="replay.backToLive()">⏭</button>
    </div>
    <input
      type="range" class="rb-slider"
      :min="0" :max="Math.max(0, replay.journal.length - 1)"
      :value="sliderVal"
      @input="replay.viewEntry(+$event.target.value)"
    />
    <button class="rb-speed" title="播放速度" @click="cycleSpeed">{{ replay.speed }}×</button>
    <button v-if="replay.replaying" class="rb-fork" @click="replay.fork()">🔀 从此恢复演练</button>
    <button class="rb-exit" @click="replay.backToLive()">✕ 退出复盘</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useReplayStore } from '@/store/replay'

const replay = useReplayStore()
const sliderVal = computed(() =>
  replay.cursor !== null ? replay.cursor : replay.journal.length - 1
)
const togglePlay = () => (replay.playing ? replay.pause() : replay.play())
const cycleSpeed = () => replay.setSpeed(replay.speed === 1 ? 2 : replay.speed === 2 ? 4 : 1)
</script>

<style scoped>
.replay-bar {
  position: absolute;
  left: 50%; bottom: 14px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  max-width: calc(100% - 40px);
  background: rgba(21, 17, 48, 0.94);
  border: 1px solid rgba(156, 77, 255, 0.5);
  border-radius: 12px; padding: 8px 14px;
  z-index: 5; backdrop-filter: blur(6px);
  box-shadow: 0 8px 28px rgba(0,0,0,0.5), 0 0 18px rgba(156,77,255,0.15);
  color: #dbe4f3; font-size: 12px;
}
.rb-tag {
  font-weight: 700; color: #ce93ff; white-space: nowrap;
  text-shadow: 0 0 8px rgba(206,147,255,0.5);
}
.rb-info {
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #aebadd; font-size: 11px;
}
.rb-info b { color: #ce93ff; }
.rb-controls { display: flex; gap: 4px; }
.rb-controls button {
  width: 28px; height: 26px; border-radius: 6px; cursor: pointer;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.3); color: #aebadd;
  font-size: 11px; line-height: 1;
}
.rb-controls button:hover { color: #fff; border-color: #9c4dff; }
.rb-controls button.play {
  background: rgba(156,77,255,0.2); border-color: rgba(156,77,255,0.55); color: #e1bee7;
}
.rb-slider {
  width: 180px; accent-color: #9c4dff; cursor: pointer;
}
.rb-speed {
  min-width: 34px; height: 26px; border-radius: 6px; cursor: pointer;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.3);
  color: #7ef0c9; font-size: 11px; font-weight: 700;
}
.rb-fork {
  height: 26px; padding: 0 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  background: rgba(156,77,255,0.16); border: 1px solid rgba(156,77,255,0.55);
  color: #e1bee7; font-size: 11px; font-weight: 600;
}
.rb-fork:hover { background: rgba(156,77,255,0.3); color: #fff; }
.rb-exit {
  height: 26px; padding: 0 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  background: transparent; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8; font-size: 11px;
}
.rb-exit:hover { color: #fff; border-color: #ef5350; }

@media (max-width: 1000px) {
  .rb-info { display: none; }
  .rb-slider { width: 100px; }
}
</style>
