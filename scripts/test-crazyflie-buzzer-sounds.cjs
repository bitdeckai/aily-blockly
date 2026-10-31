const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('firmware sounds parse, execute in every dispatcher, stop on cancellation and surface parameter errors', () => {
  const result = spawnSync('py', ['-3', '-B', '-c', `
import ast, copy, json, re, sys
from pathlib import Path
from types import SimpleNamespace
tree = ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
class Clock:
    now = 0.0
    def time(self): return self.now
    def sleep(self, seconds): self.now += seconds
clock = Clock()
values, executed = [], []
def set_value(name, value): values.append((name, value))
scf = SimpleNamespace(cf=SimpleNamespace(param=SimpleNamespace(set_value=set_value)))
namespace = {"time": clock, "re": re, "json": json, "scf": scf,
    "ensure_running": lambda: None, "ensure_link_ok": lambda: None,
    "require_link_gate": lambda name: None, "_emit_step": lambda *args: None,
    "step_index": 0, "total_steps": 1, "executed": executed}
names = ["parse_commands", "parse_motion_call", "parse_ai_deck_call", "_normalize_print_value",
    "validate_ai_deck_sequence", "interruptible_sleep", "buzzer_play_sound"]
exec(compile(ast.Module(body=[functions[name] for name in names], type_ignores=[]), "<production>", "exec"), namespace)
for effect in (2, 3, 4, 6, 7):
    assert namespace["parse_commands"](f"cf_buzzer_play_sound({effect}, 1500)") == [
        ("buzzer_play_sound", {"effect": effect, "duration": 1500})]
for code in ("cf_buzzer_play_sound(99, 1500)", "cf_buzzer_play_sound(6, 99)", "cf_buzzer_play_sound(6, 5001)"):
    try: namespace["parse_commands"](code)
    except ValueError: pass
    else: raise AssertionError("Invalid sound was accepted")
parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
handlers = []
for node in ast.walk(tree):
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare): continue
    if ast.unparse(node.test) in ("cmd == 'buzzer_play_sound'", "child_cmd == 'buzzer_play_sound'"):
        handlers.append(node)
assert len(handlers) == 3
for handler in handlers:
    parent = parents.get(handler)
    while parent:
        if isinstance(parent, ast.If) and "has_buzzer_cmd" in ast.unparse(parent.test):
            flags = {"has_motion_cmd":False,"has_motor_cmd":False,"has_flow_detect_cmd":False,
                "has_mr_cmd":False,"has_led_cmd":False,"has_buzzer_cmd":True}
            assert eval(compile(ast.Expression(parent.test), "<route>", "eval"), flags)
        parent = parents.get(parent)
    values.clear(); executed.clear(); clock.now = 0.0
    namespace.update(cmd="buzzer_play_sound", child_cmd="buzzer_play_sound",
        arg={"effect":6,"duration":1500}, child_arg={"effect":6,"duration":1500})
    isolated = copy.deepcopy(handler); isolated.orelse = []
    exec(compile(ast.Module(body=[isolated], type_ignores=[]), "<dispatcher>", "exec"), namespace)
    assert values == [("sound.effect","6"),("sound.effect","0")], values
    assert executed == ["buzzer_play_sound:6:1500:1"], executed
    assert abs(clock.now - 1.5) < 0.001
values.clear(); clock.now = 0.0
def cancel():
    if clock.now >= 0.1: raise RuntimeError("cancelled")
try: namespace["buzzer_play_sound"](scf, 6, 5000, cancel)
except RuntimeError as error: assert str(error) == "cancelled"
else: raise AssertionError("Cancellation was ignored")
assert values[-1] == ("sound.effect","0")
assert clock.now < 0.2
values.clear()
def fail(name, value):
    values.append((name,value))
    if value != "0": raise RuntimeError("sound parameter unavailable")
scf.cf.param.set_value = fail
try: namespace["buzzer_play_sound"](scf, 6, 1500, lambda: None)
except RuntimeError as error: assert "unavailable" in str(error)
else: raise AssertionError("Parameter failure was hidden")
assert values[-1] == ("sound.effect","0")
print("All firmware sound dispatchers and cancellation checks passed")
`, path.resolve(__dirname, '..', 'child', 'scripts', 'crazyflie_run_flow.py')], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
