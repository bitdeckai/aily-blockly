import os
import sys
import traceback


def clear_scene() -> None:
    import bpy

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def import_mesh(input_path: str) -> None:
    import bpy

    ext = os.path.splitext(input_path)[1].lower()
    if ext == '.dae':
        bpy.ops.wm.collada_import(filepath=input_path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=input_path)
    elif ext == '.stl':
        bpy.ops.wm.stl_import(filepath=input_path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=input_path)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=input_path)
    else:
        raise RuntimeError(f'Unsupported input extension: {ext}')


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
        print('Usage: blender -b -P blender-convert-to-glb.py -- <input_mesh> <output_glb>')
        return 2

    input_path = os.path.abspath(argv[0])
    output_path = os.path.abspath(argv[1])

    if not os.path.exists(input_path):
        print(f'Input file not found: {input_path}')
        return 3

    try:
        clear_scene()
        import_mesh(input_path)
        export_glb(output_path)
        print(f'Converted: {input_path} -> {output_path}')
        return 0
    except Exception as exc:
        print(f'Conversion failed: {exc}')
        traceback.print_exc()
        return 4


if __name__ == '__main__':
    raise SystemExit(main())
