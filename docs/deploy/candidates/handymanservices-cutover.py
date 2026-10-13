#!/usr/bin/env python3
"""Bounded operator migration. Run on werewolf-alpha after PSM approves production.
Inspect is read-only. Switch requires the exact healthy new release and managed ingress.
Cleanup is separate and requires the final successful PSM run receipt from the caller.
"""
import argparse,hashlib,json,os,subprocess,time,urllib.request
HOST='handymanservices.werewolf.solutions'
OLD='/etc/nginx/sites-enabled/handymanservices'
NEW='/etc/nginx/sites-enabled/'+HOST
BACKUP='/var/backups/psm-handymanservices-20261006'
LEGACY_SHA='08a26ee6a60e81e634ab72a9d0b200b12513b4861ce7af233d23cabdee70c125'
TARGET='/etc/psm-deploy/targets/0bd09ba0e05cbe568e3e3444b97e59e011961a3f3a968b7d3121f952b63b9e39.json'
TARGET_SHA='8c903ecef40935931198c1a75554f5b11fb5d5c90e4cca2e612cdb351928124d'

def command(args):
    r=subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
    if r.returncode:raise RuntimeError('Command failed: '+args[0])

def receipt(url):
    with urllib.request.urlopen(url,timeout=3) as r:
        if r.status!=200:raise RuntimeError('Unexpected HTTP status')
        return json.loads(r.read(16384))

def candidate(expected):
    if hashlib.sha256(open(TARGET,'rb').read()).hexdigest()!=TARGET_SHA:raise RuntimeError('Production contract changed')
    config=json.load(open(TARGET))
    if config['targetId']!='werewolf:handymanservices-production-web' or config['canonicalRoot']!='/srv/'+HOST:raise RuntimeError('Unexpected target')
    port=config['service']['port']
    health=receipt('http://127.0.0.1:'+str(port)+'/healthz')
    version=receipt('http://127.0.0.1:'+str(port)+'/version.json')
    if health.get('ok') is not True or any(version.get(k)!=v for k,v in expected.items()):raise RuntimeError('Candidate release is not verified')
    command(['systemctl','is-active','--quiet',config['service']['unitName']])
    return config

def switch(expected):
    config=candidate(expected)
    if not os.path.islink(NEW) or os.path.realpath(NEW)!='/etc/nginx/sites-available/'+HOST:raise RuntimeError('Managed ingress missing')
    text=open(os.path.realpath(NEW)).read()
    if '# managed-by: psm-host-helper/v1' not in text or '# target: '+config['targetId'] not in text or '127.0.0.1:'+str(config['service']['port']) not in text:raise RuntimeError('Managed ingress differs')
    if not os.path.islink(OLD) or os.path.realpath(OLD)!='/etc/nginx/sites-available/handymanservices':raise RuntimeError('Legacy route changed')
    if hashlib.sha256(open(os.path.realpath(OLD),'rb').read()).hexdigest()!=LEGACY_SHA:raise RuntimeError('Legacy route changed')
    if not os.path.isfile(BACKUP+'/legacy-code.tar.gz'):raise RuntimeError('Recovery archive missing')
    old_target=os.readlink(OLD)
    os.unlink(OLD)
    try:
        command(['nginx','-t']);command(['systemctl','reload','nginx'])
        deadline=time.monotonic()+15
        while True:
            try:
                public=receipt('https://'+HOST+'/version.json')
                if any(public.get(k)!=v for k,v in expected.items()):raise RuntimeError('Public release differs')
                if receipt('https://'+HOST+'/healthz').get('ok') is not True:raise RuntimeError('Public health failed')
                break
            except Exception:
                if time.monotonic()>=deadline:raise
                time.sleep(.25)
    except Exception:
        # The old site sorts first and restores the previously serving route.
        if not os.path.lexists(OLD):os.symlink(old_target,OLD)
        command(['nginx','-t']);command(['systemctl','reload','nginx'])
        raise RuntimeError('Cutover failed; legacy routing restored')
    print(json.dumps({'switched':True,'hostname':HOST,'version':expected['version'],'legacyProcessStillAvailableForRecovery':True}))

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['inspect','switch']);p.add_argument('--commit');p.add_argument('--artifact');p.add_argument('--version');a=p.parse_args()
    if a.mode=='inspect':
        print(json.dumps({'legacyEnabled':os.path.islink(OLD),'managedEnabled':os.path.islink(NEW),'backupReady':os.path.isfile(BACKUP+'/legacy-code.tar.gz'),'targetPresent':os.path.isfile(TARGET)}));return
    if os.geteuid()!=0 or not a.commit or not a.artifact or not a.version:raise RuntimeError('Root and exact release identity are required')
    switch({'commit':a.commit,'psmArtifactId':a.artifact,'version':a.version})
if __name__=='__main__':main()
