require 'rspec'
require 'net/http'

RSpec.describe Net::HTTP do
  describe '.new' do
    it 'creates an instance for the given host and port' do
      http = described_class.new('example.com', 80)
      expect(http).to be_a(described_class)
      expect(http.address).to eq('example.com')
      expect(http.port).to eq(80)
    end

    it 'defaults port to Net::HTTP.http_default_port when only host is provided' do
      http = described_class.new('example.com')
      expect(http.port).to eq(described_class.http_default_port)
    end
  end

  describe '#address' do
    it 'returns the host provided at initialization' do
      http = described_class.new('example.com', 443)
      expect(http.address).to eq('example.com')
    end
  end

  describe '#port' do
    it 'returns the port provided at initialization' do
      http = described_class.new('example.com', 443)
      expect(http.port).to eq(443)
    end

    it 'defaults to Net::HTTP.http_default_port when port is not provided' do
      http = described_class.new('example.com')
      expect(http.port).to eq(described_class.http_default_port)
    end
  end
end