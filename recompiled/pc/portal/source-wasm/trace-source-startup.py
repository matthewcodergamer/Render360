#!/usr/bin/env python3
"""Inject low-volume startup traces into the pinned Source checkout used by Render360.

This file patches only the temporary GitHub Actions checkout. It is deliberately
kept outside the upstream source tree so the exact pinned Source commit remains
reproducible.
"""
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: trace-source-startup.py <source-engine-dir>")

root = Path(sys.argv[1]).resolve()


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"Could not locate {label} in {path}")
    path.write_text(text.replace(old, new, 1))


# The latest iPhone trace proves the filesystem SIDE_MODULE enters
# CreateInterfaceInternal(), matches VFileSystem022 and returns a non-null
# singleton. Trace the caller immediately after that return, then every outer
# app-system Connect()/Init() boundary. This distinguishes a cross-module return
# trap from a virtual-method ABI/lifecycle failure without changing behavior.
app_group = root / "appframework/AppSystemGroup.cpp"
text = app_group.read_text()
if '#include "tier0/dbg.h"' not in text:
    marker = '#include "filesystem_init.h"\n'
    if marker not in text:
        raise SystemExit("Could not locate AppSystemGroup include insertion point")
    text = text.replace(marker, marker + '#include "tier0/dbg.h"\n', 1)

old_add = '''\tint retval;\n\tvoid *pSystem = pFactory( pInterfaceName, &retval );\n\tif ((retval != IFACE_OK) || (!pSystem))\n\t{\n\t\tWarning("AppFramework : Unable to create system %s!\\n", pInterfaceName );\n\t\treturn NULL;\n\t}\n\n\tIAppSystem *pAppSystem = static_cast<IAppSystem*>(pSystem);\n\t\n\tint sysIndex = m_Systems.AddToTail( pAppSystem );\n\n\t// Inserting into the dict will help us do named lookup later\n\tMEM_ALLOC_CREDIT();\n\tm_SystemDict.Insert( pInterfaceName, sysIndex );\n\treturn pAppSystem;\n'''
new_add = '''\tint retval;\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 AppFramework AddSystem factory call · %s\\n", pInterfaceName ? pInterfaceName : "(null)");\n#endif\n\tvoid *pSystem = pFactory( pInterfaceName, &retval );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 AppFramework AddSystem factory returned · %s · retval %d · %p\\n", pInterfaceName ? pInterfaceName : "(null)", retval, pSystem);\n#endif\n\tif ((retval != IFACE_OK) || (!pSystem))\n\t{\n\t\tWarning("AppFramework : Unable to create system %s!\\n", pInterfaceName );\n\t\treturn NULL;\n\t}\n\n\tIAppSystem *pAppSystem = static_cast<IAppSystem*>(pSystem);\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 AppFramework AddSystem cast ready · %s · %p\\n", pInterfaceName ? pInterfaceName : "(null)", pAppSystem);\n#endif\n\t\n\tint sysIndex = m_Systems.AddToTail( pAppSystem );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 AppFramework AddSystem vector added · %s · index %d\\n", pInterfaceName ? pInterfaceName : "(null)", sysIndex);\n#endif\n\n\t// Inserting into the dict will help us do named lookup later\n\tMEM_ALLOC_CREDIT();\n\tm_SystemDict.Insert( pInterfaceName, sysIndex );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 AppFramework AddSystem registered · %s · index %d\\n", pInterfaceName ? pInterfaceName : "(null)", sysIndex);\n#endif\n\treturn pAppSystem;\n'''
if old_add not in text:
    raise SystemExit("Could not locate CAppSystemGroup::AddSystem factory body")
text = text.replace(old_add, new_add, 1)

old_connect = '''bool CAppSystemGroup::ConnectSystems()\n{\n\tfor (int i = 0; i < m_Systems.Count(); ++i )\n\t{\n\t\tIAppSystem *sys = m_Systems[i];\n\n\t\tif (!sys->Connect( GetFactory() ))\n\t\t{\n\t\t\tReportStartupFailure( CONNECTION, i );\n\t\t\treturn false;\n\t\t}\n\t}\n\treturn true;\n}\n'''
new_connect = '''bool CAppSystemGroup::ConnectSystems()\n{\n\tfor (int i = 0; i < m_Systems.Count(); ++i )\n\t{\n\t\tIAppSystem *sys = m_Systems[i];\n#ifdef __EMSCRIPTEN__\n\t\tMsg("Render360 AppFramework Connect enter · index %d · %p\\n", i, sys);\n#endif\n\t\tbool connected = sys->Connect( GetFactory() );\n#ifdef __EMSCRIPTEN__\n\t\tMsg("Render360 AppFramework Connect returned · index %d · result %d\\n", i, connected ? 1 : 0);\n#endif\n\t\tif (!connected)\n\t\t{\n\t\t\tReportStartupFailure( CONNECTION, i );\n\t\t\treturn false;\n\t\t}\n\t}\n\treturn true;\n}\n'''
if old_connect not in text:
    raise SystemExit("Could not locate CAppSystemGroup::ConnectSystems")
text = text.replace(old_connect, new_connect, 1)

old_init = '''InitReturnVal_t CAppSystemGroup::InitSystems()\n{\n\tfor (int i = 0; i < m_Systems.Count(); ++i )\n\t{\n\t\tInitReturnVal_t nRetVal = m_Systems[i]->Init();\n\t\tif ( nRetVal != INIT_OK )\n\t\t{\n\t\t\tReportStartupFailure( INITIALIZATION, i );\n\t\t\treturn nRetVal;\n\t\t}\n\t}\n\treturn INIT_OK;\n}\n'''
new_init = '''InitReturnVal_t CAppSystemGroup::InitSystems()\n{\n\tfor (int i = 0; i < m_Systems.Count(); ++i )\n\t{\n#ifdef __EMSCRIPTEN__\n\t\tMsg("Render360 AppFramework Init enter · index %d · %p\\n", i, m_Systems[i]);\n#endif\n\t\tInitReturnVal_t nRetVal = m_Systems[i]->Init();\n#ifdef __EMSCRIPTEN__\n\t\tMsg("Render360 AppFramework Init returned · index %d · result %d\\n", i, (int)nRetVal);\n#endif\n\t\tif ( nRetVal != INIT_OK )\n\t\t{\n\t\t\tReportStartupFailure( INITIALIZATION, i );\n\t\t\treturn nRetVal;\n\t\t}\n\t}\n\treturn INIT_OK;\n}\n'''
if old_init not in text:
    raise SystemExit("Could not locate CAppSystemGroup::InitSystems")
text = text.replace(old_init, new_init, 1)
app_group.write_text(text)

# Emscripten builds the POSIX implementation, not WinApp.cpp. Trace the exact
# outer application sequence that loads VEngineCvar004 and VFileSystem022.
posix = root / "appframework/posixapp.cpp"
text = posix.read_text()
old_create = '''bool CSteamApplication::Create( )\n{\n\tFileSystem_SetErrorMode( FS_ERRORMODE_NONE );\n\n\tchar pFileSystemDLL[MAX_PATH];\n\tif ( FileSystem_GetFileSystemDLLName( pFileSystemDLL, MAX_PATH, m_bSteam ) != FS_OK )\n\t\treturn false;\n\n\t// Add in the cvar factory\n\tAppModule_t cvarModule = LoadModule( VStdLib_GetICVarFactory() );\n\tAddSystem( cvarModule, CVAR_INTERFACE_VERSION );\t\n\n\tAppModule_t fileSystemModule = LoadModule( pFileSystemDLL );\n\tm_pFileSystem = (IFileSystem*)AddSystem( fileSystemModule, FILESYSTEM_INTERFACE_VERSION );\n\tif ( !m_pFileSystem )\n\t{\n\t\tError( "Unable to load %s", pFileSystemDLL );\n\t\treturn false;\n\t}\n\n\treturn true;\n}\n'''
new_create = '''bool CSteamApplication::Create( )\n{\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication Create enter\\n");\n#endif\n\tFileSystem_SetErrorMode( FS_ERRORMODE_NONE );\n\n\tchar pFileSystemDLL[MAX_PATH];\n\tif ( FileSystem_GetFileSystemDLLName( pFileSystemDLL, MAX_PATH, m_bSteam ) != FS_OK )\n\t\treturn false;\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication filesystem module · %s\\n", pFileSystemDLL);\n#endif\n\n\t// Add in the cvar factory\n\tAppModule_t cvarModule = LoadModule( VStdLib_GetICVarFactory() );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication cvar module loaded · %d\\n", (int)cvarModule);\n#endif\n\tAddSystem( cvarModule, CVAR_INTERFACE_VERSION );\t\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication cvar system added\\n");\n#endif\n\n\tAppModule_t fileSystemModule = LoadModule( pFileSystemDLL );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication filesystem module loaded · %d\\n", (int)fileSystemModule);\n#endif\n\tm_pFileSystem = (IFileSystem*)AddSystem( fileSystemModule, FILESYSTEM_INTERFACE_VERSION );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication filesystem system added · %p\\n", m_pFileSystem);\n#endif\n\tif ( !m_pFileSystem )\n\t{\n\t\tError( "Unable to load %s", pFileSystemDLL );\n\t\treturn false;\n\t}\n\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication Create returned success\\n");\n#endif\n\treturn true;\n}\n'''
if old_create not in text:
    raise SystemExit("Could not locate POSIX CSteamApplication::Create")
text = text.replace(old_create, new_create, 1)

old_main = '''int CSteamApplication::Main( )\n{\n\t// Now that Steam is loaded, we can load up main libraries through steam\n\tm_pChildAppSystemGroup->Setup( m_pFileSystem, this );\n\treturn m_pChildAppSystemGroup->Run( );\n}\n'''
new_main = '''int CSteamApplication::Main( )\n{\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication Main enter · filesystem %p\\n", m_pFileSystem);\n#endif\n\t// Now that Steam is loaded, we can load up main libraries through steam\n\tm_pChildAppSystemGroup->Setup( m_pFileSystem, this );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication child setup complete\\n");\n#endif\n\tint result = m_pChildAppSystemGroup->Run( );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SteamApplication child returned · %d\\n", result);\n#endif\n\treturn result;\n}\n'''
if old_main not in text:
    raise SystemExit("Could not locate POSIX CSteamApplication::Main")
text = text.replace(old_main, new_main, 1)
posix.write_text(text)

# Once the outer filesystem system survives Connect/Init, the child Source group
# immediately looks it up and calls InstallDirtyDiskReportFunc. Trace that first
# IFileSystem virtual call as the next downstream boundary in the same build.
launcher = root / "launcher/launcher.cpp"
text = launcher.read_text()
old_child = '''bool CSourceAppSystemGroup::Create()\n{\n\tIFileSystem *pFileSystem = (IFileSystem*)FindSystem( FILESYSTEM_INTERFACE_VERSION );\n\tpFileSystem->InstallDirtyDiskReportFunc( ReportDirtyDiskNoMaterialSystem );\n\n#ifdef WIN32\n'''
new_child = '''bool CSourceAppSystemGroup::Create()\n{\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SourceApp Create enter\\n");\n#endif\n\tIFileSystem *pFileSystem = (IFileSystem*)FindSystem( FILESYSTEM_INTERFACE_VERSION );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SourceApp filesystem lookup returned · %p\\n", pFileSystem);\n\tMsg("Render360 SourceApp InstallDirtyDiskReportFunc enter\\n");\n#endif\n\tpFileSystem->InstallDirtyDiskReportFunc( ReportDirtyDiskNoMaterialSystem );\n#ifdef __EMSCRIPTEN__\n\tMsg("Render360 SourceApp InstallDirtyDiskReportFunc returned\\n");\n#endif\n\n#ifdef WIN32\n'''
if old_child not in text:
    raise SystemExit("Could not locate CSourceAppSystemGroup::Create filesystem boundary")
text = text.replace(old_child, new_child, 1)
launcher.write_text(text)

print("Render360 Portal: instrumented AddSystem return, Connect/Init, SteamApplication, and first child filesystem virtual call")
