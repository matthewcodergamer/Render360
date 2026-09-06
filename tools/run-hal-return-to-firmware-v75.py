#!/usr/bin/env python3
from pathlib import Path

script=Path(__file__).with_name('apply-hal-return-to-firmware-v75.py')
source=script.read_text()
old="""    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\\n}\\n''',
    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\\nuint32_t r360_kernel_import_history_count(){return render360::xenia_web::KernelImportProbeHistoryCount();}\\nuint32_t r360_kernel_import_history_thunk(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryThunk(i);}\\nuint32_t r360_kernel_import_history_module(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryModule(i);}\\nuint32_t r360_kernel_import_history_ordinal(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryOrdinal(i);}\\n}\\n''',
"""
new="""    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\\n''',
    '''uint32_t r360_kernel_import_last_status(){return render360::xenia_web::KernelImportProbeLastStatus();}\\nuint32_t r360_kernel_import_history_count(){return render360::xenia_web::KernelImportProbeHistoryCount();}\\nuint32_t r360_kernel_import_history_thunk(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryThunk(i);}\\nuint32_t r360_kernel_import_history_module(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryModule(i);}\\nuint32_t r360_kernel_import_history_ordinal(uint32_t i){return render360::xenia_web::KernelImportProbeHistoryOrdinal(i);}\\n''',
"""
if old not in source:
    raise SystemExit('V75 wrapper could not locate brittle final-export anchor in updater source')
source=source.replace(old,new,1)
globals_dict={'__name__':'__main__','__file__':str(script),'__package__':None}
exec(compile(source,str(script),'exec'),globals_dict)
