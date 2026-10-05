"""One local-workspace RCA connection. Secrets never enter the telemetry database."""
import ctypes
import hashlib
import hmac
import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


def base_url(value):
    value=value.strip().rstrip('/')
    try:
        url=urlsplit(value)
        port=url.port
    except ValueError:raise ValueError('服务地址格式不正确') from None
    local=url.hostname in ('localhost','127.0.0.1','::1')
    if (not url.hostname or url.username or url.password or url.query or url.fragment
            or any(c.isspace() or ord(c)<32 for c in value)
            or '\\' in value or url.scheme not in ('https','http')
            or (url.scheme=='http' and not local) or (port is not None and port==0)
            or url.path.endswith(('/chat/completions','/responses'))):
        raise ValueError('请填写 HTTPS API 基础地址；本机地址可用 HTTP，不包含密钥、查询参数或 /chat/completions')
    return value


class ConnectionRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    name:str=Field(min_length=1,max_length=80)
    base_url:str=Field(min_length=1,max_length=500)
    model:str=Field(min_length=1,max_length=150)
    api_key:SecretStr=Field(default=SecretStr(''),max_length=4096)
    token_parameter:str='max_tokens'
    expected_revision:str|None

    @field_validator('base_url')
    @classmethod
    def validate_url(cls,value):return base_url(value)

    @field_validator('name','model')
    @classmethod
    def validate_text(cls,value):
        value=value.strip()
        if not value or any(ord(c)<32 for c in value):raise ValueError('请输入有效名称，不包含控制字符')
        return value

    @field_validator('api_key')
    @classmethod
    def validate_key(cls,value):
        key=value.get_secret_value()
        if any(c.isspace() or ord(c)<32 for c in key):raise ValueError('密钥不能包含空白或控制字符')
        if key and len(key)<8:raise ValueError('密钥长度不足 8 个字符')
        return value

    @field_validator('token_parameter')
    @classmethod
    def validate_parameter(cls,value):
        if value not in ('max_tokens','max_completion_tokens'):raise ValueError('不支持的输出限制参数')
        return value


class DeleteRequest(BaseModel):
    model_config=ConfigDict(extra='forbid')
    expected_revision:str|None


def _dpapi(value, decrypt=False):
    """Bind the local encryption key to the current Windows user, without UI."""
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
    buffer=ctypes.create_string_buffer(value)
    incoming=Blob(len(value),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)))
    outgoing=Blob()
    function=ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    function.argtypes=[ctypes.POINTER(Blob),wintypes.LPWSTR,ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    function.restype=wintypes.BOOL
    if not function(ctypes.byref(incoming),None,None,None,None,1,ctypes.byref(outgoing)):
        raise OSError('credential_protection_failed')
    try:return ctypes.string_at(outgoing.data,outgoing.size)
    finally:
        free=ctypes.windll.kernel32.LocalFree
        free.argtypes=[ctypes.c_void_p];free.restype=ctypes.c_void_p
        free(outgoing.data)


class ModelSettings:
    def __init__(self,directory,legacy_env=None):
        self.directory=Path(directory)
        self.path=self.directory/'connection.json'
        self.key_path=self.directory/'master.key'
        self.legacy_env=Path(legacy_env) if legacy_env else None
        self.lock=threading.RLock()
        self.legacy_salt=os.urandom(32)

    def _atomic(self,path,content):
        self.directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        if os.name!='nt':os.chmod(self.directory,0o700)
        fd,name=tempfile.mkstemp(dir=self.directory,prefix='.write-',suffix='.tmp')
        try:
            with os.fdopen(fd,'wb') as file:
                file.write(content);file.flush();os.fsync(file.fileno())
            os.chmod(name,0o600)
            os.replace(name,path)
        finally:
            if os.path.exists(name):os.unlink(name)

    def _cipher(self,create=False):
        if not self.key_path.exists():
            if not create:raise OSError('credential_key_missing')
            key=Fernet.generate_key()
            self._atomic(self.key_path,_dpapi(key) if os.name=='nt' else key)
        raw=self.key_path.read_bytes()
        return Fernet(_dpapi(raw,True) if os.name=='nt' else raw)

    def _legacy(self):
        if not self.legacy_env or not self.legacy_env.exists():return None
        values={}
        for line in self.legacy_env.read_text(encoding='utf-8-sig').splitlines():
            if '=' in line and not line.lstrip().startswith('#'):
                name,value=line.split('=',1)
                if name.strip() in ('OPS_OPENAI_API_BASE_URL','OPS_OPENAI_API_KEY','OPS_OPENAI_MODEL'):
                    values[name.strip()]=value.strip().strip('"').strip("'")
        try:
            spec=ConnectionRequest(name='本地环境配置',base_url=values.get('OPS_OPENAI_API_BASE_URL',''),
                                   model=values.get('OPS_OPENAI_MODEL',''),api_key=values.get('OPS_OPENAI_API_KEY',''),expected_revision=None)
        except ValueError:return None
        if not spec.api_key.get_secret_value():return None
        revision=hmac.new(self.legacy_salt,json.dumps(values,sort_keys=True).encode(),hashlib.sha256).hexdigest()
        return {'name':spec.name,'base_url':spec.base_url,'model':spec.model,'api_key':spec.api_key.get_secret_value(),
                'token_parameter':spec.token_parameter,'revision':revision,'source':'environment','enabled':True,'updated_at':None}

    def _read(self):
        # An explicit disabled record suppresses .env fallback after deletion.
        if not self.path.exists():return self._legacy()
        record=json.loads(self.path.read_text(encoding='utf-8'))
        if (not isinstance(record,dict) or record.get('schema_version')!=1
                or not isinstance(record.get('revision'),str) or not record['revision']
                or not isinstance(record.get('enabled'),bool)):raise ValueError('credential_store_invalid')
        if not record.get('enabled'):return record
        key=self._cipher().decrypt(record.pop('encrypted_key').encode()).decode()
        ConnectionRequest(name=record['name'],base_url=record['base_url'],model=record['model'],api_key=key,
                          token_parameter=record['token_parameter'],expected_revision=record['revision'])
        record['api_key']=key
        return record

    def read(self):
        with self.lock:
            try:return self._read()
            except (OSError,ValueError,KeyError,TypeError,AttributeError,InvalidToken):
                raise HTTPException(503,'模型凭据存储无法读取，请恢复本机加密密钥或删除连接后重新配置') from None

    def public(self):
        record=self.read()
        enabled=bool(record and record.get('enabled'))
        return {'configured':enabled,'revision':record['revision'] if record else None,
                'connection':{k:record.get(k) for k in ('name','base_url','model','token_parameter','updated_at','source')} if enabled else None,
                'key_configured':enabled,'scope':'local_workspace','protocol':'openai_chat_completions',
                'protection':'windows_user_encryption' if os.name=='nt' else 'encrypted_file_owner_permissions'}

    def save(self,spec):
        with self.lock:
            current=self.read()
            if spec.expected_revision!=(current['revision'] if current else None):
                raise HTTPException(409,'模型配置已被修改，请刷新后再保存')
            key=spec.api_key.get_secret_value()
            if not key:
                if not current or not current.get('enabled'):raise HTTPException(422,'首次配置请填写 API Key')
                if current['base_url']!=spec.base_url:raise HTTPException(422,'更换服务地址时请重新填写该服务的 API Key')
                key=current['api_key']
            record={'schema_version':1,'enabled':True,'name':spec.name,'base_url':spec.base_url,'model':spec.model,
                    'token_parameter':spec.token_parameter,'revision':uuid4().hex,'source':'managed',
                    'updated_at':datetime.now(timezone.utc).isoformat()}
            try:
                record['encrypted_key']=self._cipher(True).encrypt(key.encode()).decode()
                self._atomic(self.path,json.dumps(record,ensure_ascii=False).encode())
            except OSError:raise HTTPException(503,'模型凭据无法保存，请检查本地目录权限') from None
            return self.public()

    def delete(self,spec):
        with self.lock:
            # A corrupt encrypted store can still be explicitly removed.
            try:current=self.read();revision=current['revision'] if current else None
            except HTTPException:
                revision=None
            if spec.expected_revision!=revision:raise HTTPException(409,'模型配置已被修改，请刷新后再删除')
            try:
                self._atomic(self.path,json.dumps({'schema_version':1,'enabled':False,'revision':uuid4().hex}).encode())
                self.key_path.unlink(missing_ok=True)
            except OSError:raise HTTPException(503,'模型连接无法删除，请检查本地目录权限') from None
            return self.public()


def router(manager):
    api=APIRouter()
    def headers(response):response.headers['Cache-Control']='no-store'

    @api.get('/api/settings/rca-model')
    def get(response:Response):
        headers(response)
        return manager.models.public()|{'call_status':manager.capabilities()['analyst']}

    @api.put('/api/settings/rca-model')
    def save(spec:ConnectionRequest,response:Response):
        headers(response)
        with manager.lock:return manager.models.save(spec)|{'call_status':'configured'}

    @api.delete('/api/settings/rca-model')
    def delete(spec:DeleteRequest,response:Response):
        headers(response)
        with manager.lock:return manager.models.delete(spec)|{'call_status':'unconfigured'}
    return api
