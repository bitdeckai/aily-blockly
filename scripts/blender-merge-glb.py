import os
import sys
import traceback


def clear_scene() -> None:
    import bpy

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def import_glb(input_path: str) -> None:
    import bpy

    bpy.ops.import_scene.gltf(filepath=input_path)


def export_glb(output_path: str) -> None:
    import bpy

    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB', export_apply=True)


def main() -> int:
    argv = sys.argv
    if '--' in argv:
        argv = argv[argv.index('--') + 1 :]
    else:
        argv = []

    if len(argv) < 2:
        print('Usage: blender -b -P blender-merge-glb.py -- <output_glb> <input1.glb> [input2.glb ...]')
        return 2

    output_path = os.path.abspath(argv[0])
    input_paths = [os.path.abspath(item) for item in argv[1:]]

    missing = [item for item in input_paths if not os.path.exists(item)]
    if missing:
      print('Missing input files:')
      for item in missing:
          print(item)
      return 3

    try:
        clear_scene()
        for input_path in input_paths:
            import_glb(input_path)
        export_glb(output_path)
        print(f'Merged {len(input_paths)} files -> {output_path}')
        return 0
    except Exception as exc:
        print(f'Merge failed: {exc}')
        traceback.print_exc()
        return 4


if __name__ == '__main__':
    raise SystemExit(main())
