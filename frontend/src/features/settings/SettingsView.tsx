import type { AuthSession } from "../../lib/api";
import { Volume2 } from "lucide-react";

const realtimeVoices = ["Cherry", "Serena", "Ethan", "Chelsie"] as const;
type RealtimeVoice = (typeof realtimeVoices)[number];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function VoicePicker({
  selectedVoice,
  setSelectedVoice,
}: {
  selectedVoice: RealtimeVoice;
  setSelectedVoice: (voice: RealtimeVoice) => void;
}) {
  return (
    <section className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-black text-slate-900">音色选择</h2>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">下一次模型音频回复将使用所选音色。</p>
        </div>
        <Volume2 size={18} className="text-slate-400" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
        {realtimeVoices.map((voice) => (
          <button
            key={voice}
            className={cx(
              "h-10 rounded-2xl text-sm font-black transition",
              selectedVoice === voice
                ? "bg-slate-950 text-white shadow-sm"
                : "bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-white",
            )}
            onClick={() => setSelectedVoice(voice)}
            type="button"
          >
            {voice}
          </button>
        ))}
      </div>
    </section>
  );
}


export function SettingsView({
  selectedVoice,
  setSelectedVoice,
  user,
}: {
  selectedVoice: RealtimeVoice;
  setSelectedVoice: (voice: RealtimeVoice) => void;
  user: AuthSession["user"];
}) {
  return (
    <section className="max-w-3xl rounded-[2rem] border border-slate-200 bg-white p-7 shadow-soft">
      <div>
        <h2 className="text-2xl font-black">系统设置</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">管理账号资料和实时语音偏好。</p>
      </div>
      <div className="mt-6 grid gap-4">
        <ReadonlyField label="用户名" value={user.username} />
        <ReadonlyField label="用户 ID" value={user.id} />
        <VoicePicker selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
      </div>
    </section>
  );
}


function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid gap-2 text-sm font-bold text-slate-600">
      {label}
      <input className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none" value={value} readOnly />
    </label>
  );
}
