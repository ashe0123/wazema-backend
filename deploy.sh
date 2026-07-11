#!/bin/bash

# Wazema SCBC Production Deployment Script
# This script helps deploy and manage the production environment

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if .env exists
check_env() {
    if [ ! -f .env ]; then
        print_error ".env file not found!"
        print_warning "Copy .env.production.example to .env and configure it"
        echo "  cp .env.production.example .env"
        exit 1
    fi
    print_success ".env file found"
}

# Check if required env vars are set
check_required_vars() {
    print_header "Checking Environment Variables"
    
    required_vars=("JWT_SECRET" "DATABASE_URL" "ADMIN_USERNAME" "ADMIN_PASSWORD")
    missing=0
    
    for var in "${required_vars[@]}"; do
        if grep -q "^${var}=.\+" .env 2>/dev/null; then
            print_success "$var is set"
        else
            print_error "$var is missing or empty"
            missing=1
        fi
    done
    
    # Check optional but recommended vars
    if grep -q "^REDIS_URL=.\+" .env 2>/dev/null; then
        print_success "REDIS_URL is set (recommended)"
    else
        print_warning "REDIS_URL not set - will use in-memory cache"
    fi
    
    if grep -q "^DB_POOL_MAX=.\+" .env 2>/dev/null; then
        print_success "DB_POOL_MAX is set"
    else
        print_warning "DB_POOL_MAX not set - using default (20)"
    fi
    
    if [ $missing -eq 1 ]; then
        print_error "Some required environment variables are missing"
        exit 1
    fi
}

# Check if Node.js is installed
check_node() {
    print_header "Checking Node.js Installation"
    
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        exit 1
    fi
    
    NODE_VERSION=$(node -v)
    print_success "Node.js $NODE_VERSION is installed"
    
    # Check if version is >= 18
    NODE_MAJOR=$(node -v | cut -d'.' -f1 | sed 's/v//')
    if [ "$NODE_MAJOR" -lt 18 ]; then
        print_warning "Node.js version should be >= 18"
    fi
}

# Install dependencies
install_deps() {
    print_header "Installing Dependencies"
    npm install
    print_success "Dependencies installed"
}

# Check database connection
check_db() {
    print_header "Testing Database Connection"
    
    if node verify-connection.js; then
        print_success "Database connection successful"
    else
        print_error "Database connection failed"
        print_warning "Check your DATABASE_URL in .env"
        exit 1
    fi
}

# Create logs directory
setup_logs() {
    print_header "Setting Up Logs Directory"
    
    if [ ! -d "logs" ]; then
        mkdir -p logs
        print_success "Created logs directory"
    else
        print_success "Logs directory exists"
    fi
}

# Start with PM2
start_pm2() {
    print_header "Starting with PM2"
    
    if ! command -v pm2 &> /dev/null; then
        print_warning "PM2 not installed globally"
        echo "  Installing PM2..."
        npm install -g pm2
    fi
    
    # Check if already running
    if pm2 list | grep -q "wazema-api"; then
        print_warning "Wazema API is already running"
        read -p "Do you want to reload it? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            pm2 reload ecosystem.config.js
            print_success "Application reloaded (zero downtime)"
        fi
    else
        pm2 start ecosystem.config.js
        print_success "Application started"
    fi
    
    # Save PM2 config
    pm2 save
    print_success "PM2 configuration saved"
}

# Start normally (without PM2)
start_normal() {
    print_header "Starting Application"
    
    print_warning "Starting without PM2 clustering"
    print_warning "For production with 2000+ users, use PM2 instead"
    echo ""
    
    node server.js
}

# Display status
show_status() {
    print_header "Application Status"
    
    if command -v pm2 &> /dev/null && pm2 list | grep -q "wazema-api"; then
        pm2 list
        echo ""
        print_success "Application is running with PM2"
        echo ""
        echo "Commands:"
        echo "  npm run pm2:logs     - View logs"
        echo "  npm run pm2:monit    - Monitor performance"
        echo "  npm run pm2:reload   - Reload (zero downtime)"
        echo "  npm run pm2:stop     - Stop application"
    else
        print_warning "Application not running with PM2"
    fi
}

# Display system recommendations
show_recommendations() {
    print_header "System Recommendations for 2000+ Users"
    
    echo ""
    echo "✅ Required:"
    echo "  • PostgreSQL database (configured)"
    echo "  • 4+ CPU cores"
    echo "  • 8+ GB RAM"
    echo "  • DB_POOL_MAX >= 20"
    echo ""
    echo "🔧 Recommended:"
    echo "  • Redis for caching"
    echo "  • PM2 cluster mode"
    echo "  • Load balancer (for multi-server)"
    echo "  • Monitoring (Sentry, UptimeRobot)"
    echo ""
    echo "📊 After deployment, monitor:"
    echo "  • GET /api/health/detailed"
    echo "  • Database connection usage"
    echo "  • Cache hit rate"
    echo "  • Memory usage (pm2 monit)"
    echo ""
}

# Main deployment function
deploy() {
    print_header "🚀 Wazema SCBC Production Deployment"
    echo ""
    
    check_env
    check_required_vars
    check_node
    install_deps
    check_db
    setup_logs
    
    echo ""
    print_header "Deployment Options"
    echo ""
    echo "1) Start with PM2 (Recommended for production)"
    echo "2) Start normally (Single process)"
    echo "3) Check status"
    echo "4) Show system recommendations"
    echo "5) Exit"
    echo ""
    read -p "Choose an option (1-5): " choice
    
    case $choice in
        1)
            start_pm2
            show_status
            ;;
        2)
            start_normal
            ;;
        3)
            show_status
            ;;
        4)
            show_recommendations
            ;;
        5)
            print_success "Goodbye!"
            exit 0
            ;;
        *)
            print_error "Invalid option"
            exit 1
            ;;
    esac
    
    echo ""
    print_success "Deployment complete!"
    echo ""
    print_warning "Next steps:"
    echo "  1. Check health: curl http://localhost:3002/api/health/detailed"
    echo "  2. Monitor logs: npm run pm2:logs"
    echo "  3. Set up external monitoring (UptimeRobot, Sentry)"
    echo "  4. Run load tests to verify performance"
    echo ""
    print_success "See SCALABILITY_GUIDE.md for more information"
}

# Run deployment
deploy
